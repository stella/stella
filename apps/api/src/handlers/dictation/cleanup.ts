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
import { readCleanupVocabulary } from "@/api/lib/dictation/organization-vocabulary";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";

import {
  acceptDictationCleanup,
  buildDictationCleanupPrompt,
  DICTATION_CLEANUP_SYSTEM_PROMPT,
  dictationCleanupModelOutputSchema,
} from "./cleanup-model";
import { resolveDictationCleanupModel } from "./cleanup-models";
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
const ORGANIZATION_VOCABULARY_READ_FAILED = failureSink({
  event: "dictation.organization_vocabulary.read_failed",
  expected: [],
});

/** The model call and the organization's words a test puts in place. */
export type DictationCleanupGeneration = DictationGeneration & {
  readVocabulary?: typeof readCleanupVocabulary;
};

type DictationCleanupOptions = DictationCleanupGeneration & {
  caller: DictationModelCaller;
  body: v.InferOutput<typeof desktopDictationCleanupRequestSchema>;
  /** The admission the caller's action admission granted this cleanup. */
  modelAdmission: ModelDispatchAdmission;
  actionSignal: AbortSignal;
};

/**
 * The words the model is told to spell: the speaker's own, then the
 * organization's words this transcript seems to mention. They only help,
 * so when the organization's cannot be read the cleanup runs with the
 * speaker's and the failure is reported.
 */
const cleanupVocabulary = async (
  { safeDb, organizationId }: DictationModelCaller,
  { transcript, vocabulary }: DictationCleanupOptions["body"],
  readVocabulary: typeof readCleanupVocabulary,
): Promise<string[] | undefined> => {
  const words = await readVocabulary({
    safeDb,
    organizationId,
    transcript,
    personal: vocabulary,
  });
  if (words.isErr()) {
    observeFailure(words.error, {
      sink: ORGANIZATION_VOCABULARY_READ_FAILED,
      ctx: { operation: "dictation.cleanup" },
    });
    return vocabulary;
  }
  return words.value;
};

/**
 * One cleanup generation, whichever credential proved its caller: the
 * transcript goes to the organization's fast model, or to the model the
 * speaker chose while the organization still offers it, and its answer is
 * accepted only when it is a plausible cleanup of that transcript, whatever
 * the speaker's own instructions asked for. The
 * caller has already authorized the member, the limit, usage and the action.
 */
export const cleanUpDictation = async ({
  body,
  readVocabulary = readCleanupVocabulary,
  ...options
}: DictationCleanupOptions) => {
  const vocabulary = await cleanupVocabulary(
    options.caller,
    body,
    readVocabulary,
  );
  const { model, ...asked } = body;
  return await generateDictationAnswer({
    ...options,
    feature: "dictation.cleanup",
    failureName: "Dictation cleanup",
    task: "short-text",
    modelId: resolveDictationCleanupModel(model, options.caller.orgAIConfig),
    deadlineMs: CLEANUP_DEADLINE_MS,
    outputTokenBudget: CLEANUP_OUTPUT_TOKENS,
    system: DICTATION_CLEANUP_SYSTEM_PROMPT,
    prompt: buildDictationCleanupPrompt(
      vocabulary === undefined ? asked : { ...asked, vocabulary },
    ),
    outputSchema: dictationCleanupModelOutputSchema,
    accept: (output) => acceptDictationCleanup(output, body),
  });
};

type DictationCleanupEndpointOptions = DictationCleanupGeneration &
  DesktopDictationGate;

/**
 * Cleans up one desktop dictation: the text the computer transcribed, never
 * its audio, goes to the organization's model, which fixes recognition
 * mistakes and turns spoken punctuation and formatting commands into typed
 * segments. The request may say where the text goes (the kind of app, and
 * when the speaker shares them the window title and the text before the
 * cursor), which only sets the register, and the speaker's own
 * instructions, which only choose among forms the rules leave open. Neither
 * the transcript, its context, the instructions nor the answer is stored or
 * logged.
 */
export const createDictationCleanupEndpoint = ({
  generateObjectForTask,
  readVocabulary,
  ...gate
}: DictationCleanupEndpointOptions = {}) =>
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
      aggregateMutation: {
        type: "independent",
        reason:
          "Returns transient typed text for one dictation and stores nothing; the action-admission lifecycle owns model usage accounting.",
      },
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
              ...(readVocabulary === undefined ? {} : { readVocabulary }),
            }),
          );
          return Result.ok(segments);
        },
      });
    },
  );

export default createDictationCleanupEndpoint();
