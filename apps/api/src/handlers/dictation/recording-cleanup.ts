import { Result } from "better-result";

import {
  type DesktopDictationRecordingCleanupRequest,
  desktopDictationRecordingCleanupRequestSchema,
  desktopDictationRecordingCleanupResponseSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";

import {
  type DesktopDictationGate,
  type DictationGeneration,
  type DictationModelCaller,
  generateDictationAnswer,
  runDesktopDictationModelAction,
} from "./model-endpoint";
import {
  acceptRecordingCleanup,
  buildRecordingCleanupPrompt,
  RECORDING_CLEANUP_OUTPUT_TOKENS,
  RECORDING_CLEANUP_SYSTEM_PROMPT,
  recordingCleanupModelOutputSchema,
} from "./recording-cleanup-model";

/** A part of up to 12,000 characters takes the stronger model well over a
 *  short dictation's few seconds. The deadline bounds the model only: the
 *  edge in front of the API ends a request that sends nothing for 60 s, so
 *  the desktop sizes its parts for an answer inside that. */
const RECORDING_CLEANUP_DEADLINE_MS = 120_000;

/**
 * Cleans one part of a recording's transcript with the organization's
 * chat model, keeping the answer only when it is a plausible cleanup of
 * that part.
 */
const cleanUpRecordingPart = async ({
  request,
  ...options
}: DictationGeneration & {
  caller: DictationModelCaller;
  request: DesktopDictationRecordingCleanupRequest;
  modelAdmission: ModelDispatchAdmission;
  actionSignal: AbortSignal;
}) =>
  await generateDictationAnswer({
    ...options,
    feature: "dictation.recording-cleanup",
    failureName: "Recording cleanup",
    task: "chat",
    deadlineMs: RECORDING_CLEANUP_DEADLINE_MS,
    outputTokenBudget: RECORDING_CLEANUP_OUTPUT_TOKENS,
    system: RECORDING_CLEANUP_SYSTEM_PROMPT,
    prompt: buildRecordingCleanupPrompt(request),
    outputSchema: recordingCleanupModelOutputSchema,
    accept: (output) => acceptRecordingCleanup(output, request.transcript),
  });

/**
 * Cleans one part of a recording the desktop transcribed, for its
 * "Transcribe a recording" window: the text, never the audio, goes to the
 * organization's model, which drops hesitations and abandoned drafts, turns
 * spoken punctuation and layout commands into Markdown, and sets apart what
 * the speaker said to whoever types the text as instructions. The end of
 * the text cleaned before this part may come along so the part continues
 * it. Neither the transcript, that text nor the answer is stored or logged.
 */
export const createRecordingCleanupEndpoint = ({
  generateObjectForTask,
  ...gate
}: DictationGeneration & DesktopDictationGate = {}) =>
  declareAggregateMutation(
    createSafeBoundedPublicHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "auth_plumbing" },
        cache: { kind: "none" },
        body: desktopDictationRecordingCleanupRequestSchema,
        response: safePublicHandlerResponseSchemasWithStatusText(
          desktopDictationRecordingCleanupResponseSchema,
        ),
      },
      async function* (ctx) {
        return yield* runDesktopDictationModelAction({
          ctx,
          modelTask: "chat",
          gate,
          async *handler({ caller, actionSignal, modelAdmission }) {
            const cleaned = yield* Result.await(
              cleanUpRecordingPart({
                caller,
                request: ctx.body,
                modelAdmission,
                actionSignal,
                ...(generateObjectForTask === undefined
                  ? {}
                  : { generateObjectForTask }),
              }),
            );
            return Result.ok(cleaned);
          },
        });
      },
    ),
    {
      type: "independent",
      reason:
        "Returns transient formatted text for one part of a recording and stores nothing; the action-admission lifecycle owns model usage accounting.",
    },
  );

export default createRecordingCleanupEndpoint();
