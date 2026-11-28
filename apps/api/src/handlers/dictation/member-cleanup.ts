import { Result } from "better-result";

import {
  desktopDictationCleanupRequestSchema,
  desktopDictationCleanupResponseSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";

import { cleanUpDictation } from "@/api/handlers/dictation/cleanup";
import type { DictationCleanupGeneration } from "@/api/handlers/dictation/cleanup";
import type { consumeDictationLimit } from "@/api/handlers/dictation/limits";
import { runMemberDictationModelAction } from "@/api/handlers/dictation/model-endpoint";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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
  aggregateMutation: {
    type: "independent",
    reason:
      "Returns transient typed text for one dictation and stores nothing; the action-admission lifecycle owns model usage accounting.",
  },
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
  limit,
  ...generation
}: MemberDictationCleanupOptions = {}) =>
  createSafeRootHandler(
    config,
    async function* (ctx) {
      return yield* runMemberDictationModelAction({
        ctx,
        modelAdmission: configuredModelAdmission({
          modelAdmission: ctx.modelAdmission,
        }),
        limit,
        async *run({ caller, modelAdmission, actionSignal }) {
          const segments = yield* Result.await(
            cleanUpDictation({
              caller,
              body: ctx.body,
              modelAdmission,
              actionSignal,
              ...generation,
            }),
          );
          return Result.ok(segments);
        },
      });
    },
    admit === undefined ? undefined : { admit },
  );

const cleanUpMemberDictation = createMemberDictationCleanupEndpoint();

export default cleanUpMemberDictation;
