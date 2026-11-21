import { Result } from "better-result";

import {
  desktopDictationRecordingCleanupRequestSchema,
  desktopDictationRecordingCleanupResponseSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";

import type { consumeDictationLimit } from "@/api/handlers/dictation/limits";
import {
  type DictationGeneration,
  runMemberDictationModelAction,
} from "@/api/handlers/dictation/model-endpoint";
import { cleanUpRecordingPart } from "@/api/handlers/dictation/recording-cleanup";
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
  // The cleanup step of a recording a member transcribes in the web or
  // phone app; agents do not dictate.
  mcp: { type: "internal", reason: "native_tool_ui" },
  body: desktopDictationRecordingCleanupRequestSchema,
  response: safeHandlerResponseSchemas(
    desktopDictationRecordingCleanupResponseSchema,
  ),
  requiresUsage: { actionType: "chat", modelTask: "chat" },
} as const satisfies HandlerConfig;

/**
 * Cleans one part of a recording a signed-in member transcribed, the way a
 * linked desktop's recording is cleaned: the text, never the audio, goes to
 * the organization's chat model, and the answer comes back as instructions
 * and Markdown. Neither the transcript, the text before it nor the answer
 * is stored or logged.
 */
export const createMemberRecordingCleanupEndpoint = ({
  admit,
  limit,
  ...generation
}: DictationGeneration & {
  admit?: typeof withActionAdmission;
  limit?: typeof consumeDictationLimit;
} = {}) =>
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
          const cleaned = yield* Result.await(
            cleanUpRecordingPart({
              caller,
              request: ctx.body,
              modelAdmission,
              actionSignal,
              ...generation,
            }),
          );
          return Result.ok(cleaned);
        },
      });
    },
    admit === undefined ? undefined : { admit },
  );

const cleanUpMemberRecording = createMemberRecordingCleanupEndpoint();

declareAggregateMutation(cleanUpMemberRecording, {
  type: "independent",
  reason:
    "Returns transient formatted text for one part of a recording and stores nothing; the action-admission lifecycle owns model usage accounting.",
});

export default cleanUpMemberRecording;
