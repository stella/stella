import { Result } from "better-result";
import type * as v from "valibot";

import {
  desktopDictationCleanupRequestSchema,
  desktopDictationCleanupResponseSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";

import {
  acceptDictationCleanup,
  buildDictationCleanupPrompt,
  DICTATION_CLEANUP_SYSTEM_PROMPT,
  dictationCleanupModelOutputSchema,
} from "./cleanup-model";
import {
  type DesktopDictationGate,
  type DictationGeneration,
  type DictationModelCaller,
  generateDictationAnswer,
  runDesktopDictationModelAction,
} from "./model-endpoint";

/** The desktop stops waiting after about five seconds and types the raw
 *  transcript; a generation that outlives it would only spend usage. */
const CLEANUP_DEADLINE_MS = 5000;
const CLEANUP_OUTPUT_TOKENS = 8000;

type DictationCleanupOptions = DictationGeneration & {
  caller: DictationModelCaller;
  body: v.InferOutput<typeof desktopDictationCleanupRequestSchema>;
  /** The admission the caller's action admission granted this cleanup. */
  modelAdmission: ModelDispatchAdmission;
  actionSignal: AbortSignal;
};

/**
 * One cleanup generation, whichever credential proved its caller: the
 * transcript goes to the organization's fast model, and its answer is
 * accepted only when it is a plausible cleanup of that transcript. The
 * caller has already authorized the member, the limit, usage and the action.
 */
export const cleanUpDictation = async ({
  body,
  ...options
}: DictationCleanupOptions) =>
  await generateDictationAnswer({
    ...options,
    feature: "dictation.cleanup",
    failureName: "Dictation cleanup",
    task: "short-text",
    deadlineMs: CLEANUP_DEADLINE_MS,
    outputTokenBudget: CLEANUP_OUTPUT_TOKENS,
    system: DICTATION_CLEANUP_SYSTEM_PROMPT,
    prompt: buildDictationCleanupPrompt(body),
    outputSchema: dictationCleanupModelOutputSchema,
    accept: (output) => acceptDictationCleanup(output, body),
  });

/** The model call a test puts in place of the organization's model. */
export type DictationCleanupGeneration = DictationGeneration;

type DictationCleanupEndpointOptions = DictationGeneration &
  DesktopDictationGate;

/**
 * Cleans up one desktop dictation: the text the computer transcribed, never
 * its audio, goes to the organization's model, which fixes recognition
 * mistakes and turns spoken punctuation and formatting commands into typed
 * segments. The request may say where the text goes (the kind of app, and
 * when the speaker shares them the window title and the text before the
 * cursor), which only sets the register. Neither the transcript, its
 * context nor the answer is stored or logged.
 */
export const createDictationCleanupEndpoint = ({
  generateObjectForTask,
  ...gate
}: DictationCleanupEndpointOptions = {}) =>
  declareAggregateMutation(
    createSafeBoundedPublicHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "auth_plumbing" },
        cache: { kind: "none" },
        body: desktopDictationCleanupRequestSchema,
        response: safePublicHandlerResponseSchemasWithStatusText(
          desktopDictationCleanupResponseSchema,
        ),
      },
      async function* (ctx) {
        return yield* runDesktopDictationModelAction({
          ctx,
          modelTask: "short-text",
          gate,
          async *handler({ caller, actionSignal, modelAdmission }) {
            const segments = yield* Result.await(
              cleanUpDictation({
                caller,
                body: ctx.body,
                modelAdmission,
                actionSignal,
                ...(generateObjectForTask === undefined
                  ? {}
                  : { generateObjectForTask }),
              }),
            );
            return Result.ok(segments);
          },
        });
      },
    ),
    {
      type: "independent",
      reason:
        "Returns transient typed text for one dictation and stores nothing; the action-admission lifecycle owns model usage accounting.",
    },
  );

export default createDictationCleanupEndpoint();
