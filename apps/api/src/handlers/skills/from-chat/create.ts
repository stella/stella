import { Result } from "better-result";
import * as v from "valibot";

import { SKILL_FROM_CHAT_REFUSAL_CODE } from "@stll/api-contract";

import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import {
  assertChatThreadScopeMatches,
  resolveChatScope,
} from "@/api/handlers/chat/chat-scope";
import { buildRecapTranscript } from "@/api/handlers/chat/thread-recap-transcript";
import { loadRecapMessageWindow } from "@/api/handlers/chat/thread-recap-window";
import { findSkillDraftNames } from "@/api/lib/agent-skills/draft-names";
import {
  parseSkillDraft,
  skillDraftTexts,
} from "@/api/lib/agent-skills/draft-package";
import {
  aiGenerationSchema,
  buildSkillDraftPrompt,
} from "@/api/lib/agent-skills/draft-prompt";
import { resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { THREAD_STORED_CONTENT_SEND_MODE } from "@/api/lib/chat/thread-stored-content-send-mode";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForTask } from "@/api/lib/tanstack-ai-models";

const INTENT_MAX_CHARS = 2000;
/** Room for the method of a long chat; the recap reads far less. */
const SOURCE_TRANSCRIPT_MAX_CHARS = 24_000;
const GENERATION_TIMEOUT_MS = 90_000;
const GENERATION_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_INTENT =
  "Make a reusable skill from the work done in this chat, so the same kind of task goes the same way next time.";

const fromChatBodySchema = v.object({
  threadId: resourceIdSchema("chatThread"),
  workspaceId: v.optional(resourceIdSchema("workspace")),
  intent: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(INTENT_MAX_CHARS)),
  ),
});

const config = {
  contract: "patch",
  permissions: { agentSkill: ["create"], chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  body: fromChatBodySchema,
  // Like the draft generator: the user waits on a draft, not a reply.
  requiresUsage: {
    actionType: "chat",
    serviceTier: "flex",
    modelTask: "short-text",
  },
} satisfies HandlerConfig;

/**
 * Draft a skill from one of the caller's own chats. The chat is read as the
 * recap reads it and the model learns its method: the steps, structure,
 * sources and the corrections the lawyer made. Nothing is stored: the draft
 * comes back with the names of people and organizations it holds, for the
 * lawyer to approve or replace before `skills.save-draft` stores it.
 */
const draftSkillFromChat = createSafeRootHandler(
  config,
  async function* ({
    body,
    getWorkspaceAccess,
    managedAIResidency,
    modelAdmission,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    safeDb,
    scopedDb,
    session,
    user,
  }) {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError());
    }
    yield* requireTanStackAIAvailableForTask({
      dataClass: "customer",
      configStatus: orgAIConfigStatus,
      orgConfig: orgAIConfig,
      task: "short-text",
    });

    const scope = yield* resolveChatScope({
      admitted: "active-or-archived",
      getWorkspaceAccess,
      workspaceId: body.workspaceId,
    });
    const thread = yield* Result.await(
      safeDb((tx) =>
        tx.query.chatThreads.findFirst({
          where: { id: { eq: body.threadId }, userId: { eq: user.id } },
          columns: { workspaceId: true },
        }),
      ),
    );
    if (!thread) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: SKILL_FROM_CHAT_REFUSAL_CODE.threadNotFound,
          message: "Chat thread not found",
        }),
      );
    }
    const workspaceId = thread.workspaceId ?? null;
    yield* assertChatThreadScopeMatches({
      persistedWorkspaceId: workspaceId,
      scope,
    });

    const window = yield* Result.await(
      loadRecapMessageWindow({
        safeDb,
        threadId: body.threadId,
        userId: user.id,
      }),
    );
    if (window.sendMode === THREAD_STORED_CONTENT_SEND_MODE.anonymized) {
      return Result.err(
        new HandlerError({
          status: 409,
          code: SKILL_FROM_CHAT_REFUSAL_CODE.anonymizedThread,
          message: "A skill cannot be drafted from an anonymized chat yet",
        }),
      );
    }
    if (window.withdrawnMarker !== null) {
      return Result.err(
        new HandlerError({
          status: 409,
          code: SKILL_FROM_CHAT_REFUSAL_CODE.withdrawn,
          message: "This chat's content was withdrawn",
        }),
      );
    }
    const transcript = buildRecapTranscript(
      window.messages.map((row) => {
        const message = chatMessageFromPersisted(row);
        return { role: message.role, parts: message.parts };
      }),
      SOURCE_TRANSCRIPT_MAX_CHARS,
    );
    if (!transcript) {
      return Result.err(
        new HandlerError({
          status: 422,
          code: SKILL_FROM_CHAT_REFUSAL_CODE.emptyThread,
          message: "This chat has nothing to draft a skill from yet",
        }),
      );
    }

    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      dataClass: "customer",
      usageMetering: {
        actionType: "chat",
        organizationId: session.activeOrganizationId,
        safeDb,
        serviceTier: "flex",
        userId: user.id,
        workspaceId,
      },
      feature: "skills.from_chat",
      modelTask: "short-text",
      orgAIConfig,
      modelTier: configuredModelAdmission({ modelAdmission }).modelTier,
      properties: { organization_id: session.activeOrganizationId },
      traceId: Bun.randomUUIDv7(),
    });
    const generation = await Result.tryPromise({
      try: async () =>
        await generateTanStackObjectForTask({
          userId: user.id,
          dataClass: "customer",
          admission: configuredModelAdmission({ modelAdmission }),
          deadlineMs: GENERATION_TIMEOUT_MS,
          maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS,
          task: "short-text",
          serviceTier: "flex",
          orgAIConfig,
          managedAIResidency,
          organizationId: session.activeOrganizationId,
          tenantWorkspaceIds: workspaceId === null ? [] : [workspaceId],
          analytics: aiAnalytics,
          caching: resolveCaching({
            promptCachingEnabled,
            task: "short-text",
            scopeKey: `${session.activeOrganizationId}:skills:from-chat`,
          }),
          outputSchema: aiGenerationSchema,
          prompt: buildSkillDraftPrompt({
            intent: body.intent ?? DEFAULT_INTENT,
            sourceTranscript: transcript,
          }),
        }),
      catch: (cause) => {
        aiAnalytics.captureError(cause);
        return new HandlerError({
          status: 502,
          code: "internal_error",
          message: "Could not draft a skill from this chat. Please try again.",
          cause,
        });
      },
    });
    if (Result.isError(generation)) {
      return Result.err(generation.error);
    }

    const { draft, parsed } = parseSkillDraft(generation.value);
    if (parsed.isErr()) {
      return Result.err(
        new HandlerError({
          status: 502,
          code: "internal_error",
          message: "The draft was not a valid skill. Please try again.",
          cause: parsed.error,
        }),
      );
    }
    const names = yield* Result.await(
      findSkillDraftNames({
        organizationId: session.activeOrganizationId,
        scopedDb,
        texts: skillDraftTexts(draft),
        workspaceId,
      }),
    );
    return Result.ok({ draft, names });
  },
);

export default draftSkillFromChat;
