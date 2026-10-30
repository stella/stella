import { panic, Result } from "better-result";
import * as v from "valibot";

import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import {
  assertChatThreadScopeMatches,
  resolveChatScope,
} from "@/api/handlers/chat/chat-scope";
import { buildRecapTranscript } from "@/api/handlers/chat/thread-recap-transcript";
import { loadRecapMessageWindow } from "@/api/handlers/chat/thread-recap-window";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { isUnanticipatedAIFailure } from "@/api/lib/ai-error";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  admitFiniteAction,
  authorizeHandlerUsage,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { THREAD_STORED_CONTENT_SEND_MODE } from "@/api/lib/chat/thread-stored-content-send-mode";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { cloneOperationInput } from "@/api/lib/proofs/checked-transaction";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForTask } from "@/api/lib/tanstack-ai-models";

// How many follow-up suggestions to generate. The composer shows the
// first and reveals the rest behind a toggle.
const MAX_SUGGESTIONS = 4;

const SUGGESTIONS_SYSTEM_PROMPT = `You write a list of suggested follow-up prompts for someone in a legal workspace chat.
Based on the conversation transcript, suggest up to ${MAX_SUGGESTIONS} short, natural, and distinct follow-up questions or next steps that the user might want to send next.

Each suggestion is inserted verbatim into the USER'S message composer and sent to the AI. Write strictly from the user's perspective, addressed to the AI. Never write a question that the AI would ask the user, such as "Do you want to add substitution authority?", "Would you like me to...?", "Chceš doplnit...?", or "Přejete si...?". Rewrite those as user requests, such as "Add substitution authority." or "Please generate the document as a PDF." If missing information is the natural next topic, phrase it as the user asking the AI what to provide, for example "What information do you need from me?".

Make each suggestion a concise, single-sentence prompt (e.g., "What are the key risks?", "Can you draft a response?", "Explain the governing law section.").
Do not include headings, bullet points, numbering, or introductory text. Respond only with the suggested prompts, one per line.
Write the suggestions in the same language as the conversation. Be specific to the actual topics, documents, and decisions discussed.`;

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  params: v.object({ threadId: resourceIdSchema("chatThread") }),
  query: v.object({ workspaceId: v.optional(resourceIdSchema("workspace")) }),
} satisfies HandlerConfig;

type SuggestedPromptsResult = { prompts: string[] };

type SuggestedPromptMessage = {
  parts: ReturnType<typeof normalizePersistedChatMessageContent>["parts"];
  role: ChatMessage["role"];
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

const SUGGESTION_CONVERSATION_ROLES = {
  activity: false,
  assistant: true,
  system: true,
  user: true,
} as const satisfies Record<SuggestedPromptMessage["role"], boolean>;

export const latestAssistantTurnAwaitsUser = (
  messages: readonly SuggestedPromptMessage[],
): boolean => {
  const latest = messages.findLast(
    (message) => SUGGESTION_CONVERSATION_ROLES[message.role],
  );
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
    return (
      (part.name === "ask-user" ||
        part.name === "request_secret" ||
        part.name === "connect_connector") &&
      ASK_USER_STATE_AWAITS_USER[part.state]
    );
  });
};

// Budget for the visible output: up to MAX_SUGGESTIONS single-sentence
// lines. A Czech or Slovak line of 150 characters runs to about 60 tokens, so
// four of them overran the former 256 and the run stopped mid-line. The fast
// role requests reasoning off (see the OpenRouter role defaults); if a model
// forces reasoning anyway, the reasoning-fallback middleware tops this cap up
// by a flat allowance so thinking tokens don't eat into the lines.
const SUGGESTIONS_MAX_OUTPUT_TOKENS = 512;

/**
 * The longest line kept as a suggestion. A chip is one sentence the user
 * sends verbatim; a longer line is a paragraph the prompt did not ask for, so
 * it is dropped whole, never cut to fit.
 */
export const MAX_SUGGESTION_LENGTH = 240;

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

/**
 * What one line of model output became. A suggestion is inserted verbatim as
 * the user's next message, so a line is either kept whole or dropped; nothing
 * shortens it.
 */
export type SuggestionLine =
  | { type: "complete"; prompt: string }
  | { type: "dropped"; reason: "blank" | "over-length" };

export const parseSuggestionLine = (line: string): SuggestionLine => {
  const prompt = cleanLine(line.trim());
  if (prompt.length === 0) {
    return { type: "dropped", reason: "blank" };
  }
  if (prompt.length > MAX_SUGGESTION_LENGTH) {
    return { type: "dropped", reason: "over-length" };
  }
  return { type: "complete", prompt };
};

export const cleanSuggestionsText = (text: string): string[] => {
  const prompts = text.split("\n").flatMap((line) => {
    const parsed = parseSuggestionLine(line);
    switch (parsed.type) {
      case "complete":
        return [parsed.prompt];
      case "dropped":
        return [];
      default:
        parsed satisfies never;
        return panic(`Unhandled suggestion line: ${String(parsed)}`);
    }
  });

  return Array.from(new Set(prompts)).slice(0, MAX_SUGGESTIONS);
};

/** The request fields this module owns, so no caller can loosen them. */
type SuggestionRequestKey =
  | "finishPolicy"
  | "maxOutputTokens"
  | "messages"
  | "prompt"
  | "system"
  | "systemPromptOrigin"
  | "task"
  | "temperature";

// Distributes over the dispatch-scope union, so an organization's admission
// stays paired with its organization id.
type WithoutSuggestionRequest<T> = T extends unknown
  ? Omit<T, SuggestionRequestKey>
  : never;

type SuggestedPromptsDispatch = WithoutSuggestionRequest<
  Parameters<typeof generateTanStackTextForTask>[0]
>;

/**
 * Generate the follow-up prompts for a transcript. Only a run that stopped on
 * its own counts: a run cut at the output ceiling (or moderated, or never
 * finished) ends mid-line, and its last line would reach the user as a chip
 * that stops mid-word, so it is refused whole and the caller shows none.
 */
export const generateSuggestedPrompts = async (
  transcript: string,
  options: SuggestedPromptsDispatch,
): Promise<string[]> => {
  const text = await generateTanStackTextForTask({
    ...options,
    finishPolicy: "require-complete",
    maxOutputTokens: SUGGESTIONS_MAX_OUTPUT_TOKENS,
    prompt: `Conversation transcript:\n\n${transcript}\n\nSuggested follow-up prompts:`,
    system: SUGGESTIONS_SYSTEM_PROMPT,
    systemPromptOrigin: "server-built",
    task: "short-text",
    temperature: 0.3,
  });
  return cleanSuggestionsText(text);
};

const getSuggestedPrompts = createSafeRootHandler(
  config,
  async function* (ctx) {
    const {
      getWorkspaceAccess,
      orgAIConfig,
      managedAIResidency,
      orgAIConfigStatus,
      params: { threadId },
      promptCachingEnabled,
      query: { workspaceId },
      safeDb,
      session,
      user,
    } = ctx;
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.ok<SuggestedPromptsResult>({ prompts: [] });
    }

    if (
      Result.isError(
        requireTanStackAIAvailableForTask({
          dataClass: "customer",
          configStatus: orgAIConfigStatus,
          orgConfig: orgAIConfig,
          task: "short-text",
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

    if (
      messageWindow.sendMode === THREAD_STORED_CONTENT_SEND_MODE.anonymized ||
      messageWindow.messages.length === 0
    ) {
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

    const authorization = await authorizeHandlerUsage({
      metering: { actionType: "chat", modelTask: "short-text" },
      organizationId: session.activeOrganizationId,
      orgAIConfig,
      workspaceId: persistedWorkspaceId,
      userId: user.id,
      safeDb,
      ctx,
      managedAIResidency,
      promptCachingEnabled,
      threadId,
      transcript,
    });
    if (Result.isError(authorization)) {
      return Result.err(authorization.error);
    }
    return await authorization.value.execute(async ({ proof }) => {
      const checked = proof.input.value;
      const admittedContext = cloneOperationInput(checked.ctx);
      return await Result.gen(async function* () {
        const suggestPrompts = async ({
          actionSignal,
          modelAdmission,
        }: {
          actionSignal: AbortSignal;
          modelAdmission: ModelDispatchAdmission;
        }): Promise<Result<SuggestedPromptsResult, never>> => {
          const aiAnalytics = createTanStackAIAnalyticsCallbacks({
            dataClass: "customer",
            usageMetering: {
              actionType: "chat",
              organizationId: checked.organizationId,
              safeDb: checked.safeDb,
              serviceTier: "standard",
              userId: checked.userId,
              workspaceId: checked.workspaceId,
            },
            feature: "chat.suggested_prompts",
            modelTask: "short-text",
            organizationId: checked.organizationId,
            orgAIConfig: checked.orgAIConfig,
            modelTier: modelAdmission.modelTier,
            properties: checked.workspaceId
              ? { workspace_id: checked.workspaceId }
              : {},
            traceId: Bun.randomUUIDv7(),
          });

          try {
            const prompts = await generateSuggestedPrompts(checked.transcript, {
              userId: modelAdmission.userId,
              dataClass: "customer",
              orgAIConfig: checked.orgAIConfig,
              managedAIResidency: checked.managedAIResidency,
              organizationId: checked.organizationId,
              admission: modelAdmission,
              analytics: aiAnalytics,
              caching: resolveCaching({
                promptCachingEnabled: checked.promptCachingEnabled,
                task: "short-text",
                scopeKey: checked.threadId,
              }),
              tenantWorkspaceIds: checked.workspaceId
                ? [checked.workspaceId]
                : [],
              serviceTier: "standard",
              abortSignal: actionSignal,
              deadlineMs: 15_000,
            });
            return Result.ok({ prompts });
          } catch (error) {
            aiAnalytics.captureError(error);
            if (isUnanticipatedAIFailure(error)) {
              captureError(
                error,
                handlerErrorContext("chat.suggestPrompts", {
                  threadId: checked.threadId,
                  feature: "chat.suggested_prompts",
                }),
              );
            }
            return Result.ok<SuggestedPromptsResult>({ prompts: [] });
          }
        };

        return yield* admitFiniteAction({
          actionKind: "chat.suggested-prompts",
          ctx: admittedContext,
          async *handler(admitted) {
            const suggestions = yield* Result.await(suggestPrompts(admitted));
            return Result.ok(suggestions);
          },
        });
      });
    });
  },
);

export default getSuggestedPrompts;
