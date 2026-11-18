import { Result } from "better-result";

import {
  desktopDictationCleanupRequestSchema,
  desktopDictationCleanupResponseSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";

import { cleanUpDictation } from "@/api/handlers/dictation/cleanup";
import type { DictationCleanupGeneration } from "@/api/handlers/dictation/cleanup";
import { consumeDictationLimit } from "@/api/handlers/dictation/limits";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "dictation.cleanup" },
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  // The cleanup step of a member's dictation in a native app; agents do
  // not dictate.
  mcp: { type: "internal", reason: "native_tool_ui" },
  body: desktopDictationCleanupRequestSchema,
  response: safeHandlerResponseSchemas(desktopDictationCleanupResponseSchema),
  requiresUsage: { actionType: "chat", modelTask: "short-text" },
} as const satisfies HandlerConfig;

type MemberDictationCleanupOptions = DictationCleanupGeneration & {
  admit?: typeof withActionAdmission;
  limit?: typeof consumeDictationLimit;
};

/**
 * Cleans up one transcript a signed-in member dictated, the way a linked
 * desktop's dictation is cleaned up: the text, never audio, goes to the
 * organization's model, and the answer comes back as typed segments.
 * Neither the transcript, its context nor the answer is stored or logged.
 */
export const createMemberDictationCleanupEndpoint = ({
  admit,
  limit = consumeDictationLimit,
  ...generation
}: MemberDictationCleanupOptions = {}) =>
  createSafeRootHandler(
    config,
    async function* ({
      actionSignal,
      body,
      managedAIResidency,
      modelAdmission,
      orgAIConfig,
      orgAIConfigStatus,
      promptCachingEnabled,
      request,
      safeDb,
      session,
      user,
    }) {
      if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
        return Result.err(storedAIConfigUnreadableError());
      }
      const organizationId = session.activeOrganizationId;
      yield* Result.await(
        limit({ organizationId, userId: user.id, operation: "cleanup" }),
      );
      const segments = yield* Result.await(
        cleanUpDictation({
          caller: {
            organizationId,
            userId: user.id,
            safeDb,
            orgAIConfig,
            managedAIResidency,
            promptCachingEnabled,
          },
          body,
          modelAdmission: configuredModelAdmission({ modelAdmission }),
          actionSignal: actionSignal ?? request.signal,
          ...generation,
        }),
      );
      return Result.ok(segments);
    },
    admit === undefined ? undefined : { admit },
  );

const cleanUpMemberDictation = createMemberDictationCleanupEndpoint();

declareAggregateMutation(cleanUpMemberDictation, {
  type: "independent",
  reason:
    "Returns transient typed text for one dictation and stores nothing; the action-admission lifecycle owns model usage accounting.",
});

export default cleanUpMemberDictation;
