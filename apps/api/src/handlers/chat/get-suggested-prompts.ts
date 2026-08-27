import { Result } from "better-result";
import { t } from "elysia";

import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import {
  assertChatThreadScopeMatches,
  resolveChatScope,
} from "@/api/handlers/chat/chat-scope";
import { buildRecapTranscript } from "@/api/handlers/chat/thread-recap-transcript";
import { loadRecapMessageWindow } from "@/api/handlers/chat/thread-recap-window";
import { resolveCaching } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  assertUsageAvailableForHandler,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

// How many follow-up suggestions to generate. The composer shows the
// first and reveals the rest behind a toggle.
const MAX_SUGGESTIONS = 4;

export const SUGGESTIONS_SYSTEM_PROMPT = `You write a list of suggested follow-up prompts for someone in a legal workspace chat.
Based on the conversation transcript, suggest up to ${MAX_SUGGESTIONS} short, natural, and distinct follow-up questions or next steps that the user might want to send next.

Each suggestion is inserted verbatim into the USER'S message composer and sent to the AI. Write strictly from the user's perspective, addressed to the AI. Never write a question that the AI would ask the user, such as "Do you want to add substitution authority?", "Would you like me to...?", "Chceš doplnit...?", or "Přejete si...?". Rewrite those as user requests, such as "Add substitution authority." or "Please generate the document as a PDF." If missing information is the natural next topic, phrase it as the user asking the AI what to provide, for example "What information do you need from me?".

Make each suggestion a concise, single-sentence prompt (e.g., "What are the key risks?", "Can you draft a response?", "Explain the governing law section.").
Do not include headings, bullet points, numbering, or introductory text. Respond only with the suggested prompts, one per line.
Write the suggestions in the same language as the conversation. Be specific to the actual topics, documents, and decisions discussed.`;

const config = {
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({ workspaceId: t.Optional(tSafeId("workspace")) }),
} satisfies HandlerConfig;

type SuggestedPromptsResult = { prompts: string[] };

type SuggestedPromptMessage = {
  parts: ReturnType<typeof normalizePersistedChatMessageContent>["parts"];
  role: "assistant" | "system" | "user";
};

type SuggestedPromptToolCallState = Extract<
  SuggestedPromptMessage["parts"][number],
  { type: "tool-call" }
>["state"];

const ASK_USER_STATE_AWAITS_USER = {
  "awaiting-input": true,
  "approval-requested": true,
  "approval-responded": false,
  complete: false,
  error: false,
  "input-complete": true,
  "input-streaming": true,
} as const satisfies Record<SuggestedPromptToolCallState, boolean>;

export const latestAssistantTurnAwaitsUser = (
  messages: readonly SuggestedPromptMessage[],
): boolean => {
  const latest = messages.at(-1);
  if (latest?.role !== "assistant") {
    return false;
  }

  return latest.parts.some((part) => {
    if (part.type !== "tool-call") {
      return false;
    }
    if (part.state === "approval-requested") {
      return true;
    }
    return part.name === "ask-user" && ASK_USER_STATE_AWAITS_USER[part.state];
  });
};

// Budget for the visible output only: a few short lines, well under 100
// tokens. The fast role requests reasoning off (see the OpenRouter role
// defaults); if a model forces reasoning anyway, the reasoning-fallback
// middleware tops this cap up by a flat allowance so thinking tokens don't
// eat into the lines. Re-capped at MAX_SUGGESTIONS in `cleanSuggestionsText`.
const SUGGESTIONS_MAX_OUTPUT_TOKENS = 256;

const SUGGEST_CLEANUP_STEPS = [
  /^\d+[.\-)]\s*/u, // Numbered list: "1. " or "2) " at start (optional trailing space)
  /^[-*•]\s*/u, // Bullet point at start
  /^["'([[]+/u, // Opening quotes, parens, brackets at start
  /(?<![\])"'\s])[\])"'\s]+$/u, // Closing quotes, parens, brackets, whitespace at end
] as const;

const cleanLine = (line: string): string => {
  let result = line;
  for (const re of SUGGEST_CLEANUP_STEPS) {
    result = result.replace(re, "");
  }

  return result.trim();
};

export const cleanSuggestionsText = (text: string): string[] => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .map(cleanLine)
    .filter((line) => line.length > 0);

  return Array.from(new Set(lines)).slice(0, MAX_SUGGESTIONS);
};

const getSuggestedPrompts = createSafeRootHandler(
  config,
  async function* ({
    getWorkspaceAccess,
    orgAIConfig,
    orgAIConfigStatus,
    params: { threadId },
    promptCachingEnabled,
    query: { workspaceId },
    safeDb,
    session,
    user,
  }) {
    if (
      Result.isError(
        requireTanStackAIAvailableForRole({
          configStatus: orgAIConfigStatus,
          orgConfig: orgAIConfig,
          role: "fast",
        }),
      )
    ) {
      return Result.ok<SuggestedPromptsResult>({ prompts: [] });
    }

    const scope = yield* resolveChatScope({
      getWorkspaceAccess,
      workspaceId,
    });

    const thread = yield* Result.await(
      safeDb((tx) =>
        tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            userId: { eq: user.id },
          },
          columns: {
            workspaceId: true,
            usedAnonymization: true,
          },
          with: {
            turns: {
              columns: { status: true },
              limit: 1,
              orderBy: { createdAt: "desc" },
            },
          },
        }),
      ),
    );

    if (!thread) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    const persistedWorkspaceId = thread.workspaceId ?? null;
    yield* assertChatThreadScopeMatches({ persistedWorkspaceId, scope });

    if (thread.usedAnonymization) {
      return Result.ok<SuggestedPromptsResult>({ prompts: [] });
    }

    const latestTurn = thread.turns.at(0);
    if (latestTurn !== undefined && latestTurn.status !== "completed") {
      return Result.ok<SuggestedPromptsResult>({ prompts: [] });
    }

    const messageWindow = yield* Result.await(
      loadRecapMessageWindow({ safeDb, threadId, userId: user.id }),
    );

    if (messageWindow.messages.length === 0) {
      return Result.ok<SuggestedPromptsResult>({ prompts: [] });
    }

    const recapMessages = messageWindow.messages.map((row) => ({
      role: row.role,
      parts: normalizePersistedChatMessageContent(row.content).parts,
    }));

    if (latestAssistantTurnAwaitsUser(recapMessages)) {
      return Result.ok<SuggestedPromptsResult>({ prompts: [] });
    }

    const transcript = buildRecapTranscript(recapMessages);
    if (!transcript) {
      return Result.ok<SuggestedPromptsResult>({ prompts: [] });
    }

    const preflightError = await assertUsageAvailableForHandler({
      metering: { actionType: "chat", modelRole: "fast" },
      organizationId: session.activeOrganizationId,
      orgAIConfig,
      workspaceId: persistedWorkspaceId,
      userId: user.id,
      safeDb,
    });
    if (preflightError) {
      return Result.err(preflightError);
    }

    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      usageMetering: {
        actionType: "chat",
        organizationId: session.activeOrganizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId: persistedWorkspaceId,
      },
      feature: "chat.suggested_prompts",
      modelRole: "fast",
      organizationId: session.activeOrganizationId,
      orgAIConfig,
      properties: persistedWorkspaceId
        ? { workspace_id: persistedWorkspaceId }
        : {},
      traceId: Bun.randomUUIDv7(),
    });

    try {
      const text = await generateTanStackTextForRole({
        role: "fast",
        orgAIConfig,
        organizationId: session.activeOrganizationId,
        analytics: aiAnalytics,
        caching: resolveCaching({
          promptCachingEnabled,
          role: "fast",
          scopeKey: threadId,
        }),
        tenantWorkspaceIds: persistedWorkspaceId ? [persistedWorkspaceId] : [],
        system: SUGGESTIONS_SYSTEM_PROMPT,
        systemPromptOrigin: "server-built",
        prompt: `Conversation transcript:\n\n${transcript}\n\nSuggested follow-up prompts:`,
        maxOutputTokens: SUGGESTIONS_MAX_OUTPUT_TOKENS,
        temperature: 0.3,
        serviceTier: "standard",
        abortSignal: AbortSignal.timeout(15_000),
      });

      const prompts = cleanSuggestionsText(text);
      return Result.ok<SuggestedPromptsResult>({ prompts });
    } catch (error) {
      aiAnalytics.captureError(error);
      captureError(error, { threadId, feature: "chat.suggested_prompts" });
      return Result.ok<SuggestedPromptsResult>({ prompts: [] });
    }
  },
);

export default getSuggestedPrompts;
