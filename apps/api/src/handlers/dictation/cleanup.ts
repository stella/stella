import { Result } from "better-result";
import type * as v from "valibot";

import {
  desktopDictationCleanupRequestSchema,
  desktopDictationCleanupResponseSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";
import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";
import { classifyFailure } from "@stll/errors";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { consumeDictationLimit } from "@/api/handlers/dictation/limits";
import { resolveCaching } from "@/api/lib/ai-config";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import type { OrgAISettings } from "@/api/lib/ai-config-loader";
import { aiHandlerError } from "@/api/lib/ai-error";
import {
  generateArtefact,
  readUnsourcedArtefact,
} from "@/api/lib/ai-generation/provenance";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  admitFiniteAction,
  authorizeHandlerUsage,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { readCleanupVocabulary } from "@/api/lib/dictation/organization-vocabulary";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";

import {
  acceptDictationCleanup,
  buildDictationCleanupPrompt,
  DICTATION_CLEANUP_SYSTEM_PROMPT,
  dictationCleanupModelOutputSchema,
} from "./cleanup-model";

const GENERATOR = "apps/api/src/handlers/dictation/cleanup.ts";
const REQUIRED_FEATURE_ID = "desktop-dictation" satisfies DesktopFeatureId;
/** The desktop stops waiting after about five seconds and types the raw
 *  transcript; a generation that outlives it would only spend usage. */
const CLEANUP_DEADLINE_MS = 5000;
const CLEANUP_OUTPUT_TOKENS = 8000;
const ORGANIZATION_VOCABULARY_READ_FAILED = failureSink({
  event: "dictation.organization_vocabulary.read_failed",
  expected: [],
});

/** Who a cleanup runs for, with the organization's AI settings. */
type DictationCleanupCaller = OrgAISettings & {
  readonly organizationId: SafeId<"organization">;
  readonly userId: SafeId<"user">;
  readonly safeDb: SafeDb;
};

type DictationCleanupOptions = {
  caller: DictationCleanupCaller;
  body: v.InferOutput<typeof desktopDictationCleanupRequestSchema>;
  /** The admission the caller's action admission granted this cleanup. */
  modelAdmission: ModelDispatchAdmission;
  actionSignal: AbortSignal;
  generateObjectForTask?: typeof generateTanStackObjectForTask;
  readVocabulary?: typeof readCleanupVocabulary;
};

/**
 * The words the model is told to spell: the speaker's own, then the
 * organization's words this transcript seems to mention. They only help,
 * so when the organization's cannot be read the cleanup runs with the
 * speaker's and the failure is reported.
 */
const cleanupVocabulary = async ({
  caller: { safeDb, organizationId },
  body: { transcript, vocabulary },
  readVocabulary,
}: {
  caller: DictationCleanupCaller;
  body: DictationCleanupOptions["body"];
  readVocabulary: typeof readCleanupVocabulary;
}): Promise<string[] | undefined> => {
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
 * transcript goes to the organization's model, and its answer is accepted
 * only when it is a plausible cleanup of that transcript. The caller has
 * already authorized the member, the limit, usage and the action.
 */
export const cleanUpDictation = async ({
  caller,
  body,
  modelAdmission,
  actionSignal,
  generateObjectForTask = generateTanStackObjectForTask,
  readVocabulary = readCleanupVocabulary,
}: DictationCleanupOptions) =>
  await Result.gen(async function* () {
    const {
      organizationId,
      userId,
      safeDb,
      orgAIConfig,
      managedAIResidency,
      promptCachingEnabled,
    } = caller;
    const analytics = createTanStackAIAnalyticsCallbacks({
      dataClass: "customer",
      feature: "dictation.cleanup",
      modelTask: "short-text",
      modelTier: modelAdmission.modelTier,
      orgAIConfig,
      properties: {},
      traceId: Bun.randomUUIDv7(),
      usageMetering: {
        actionType: "chat",
        organizationId,
        userId,
        safeDb,
        serviceTier: "standard",
        workspaceId: null,
      },
    });
    const vocabulary = await cleanupVocabulary({
      caller,
      body,
      readVocabulary,
    });
    const generated = await Result.tryPromise({
      try: async () =>
        await generateArtefact({
          generator: GENERATOR,
          // The request carries the transcript itself; no stored record or
          // decision feeds the answer.
          sources: { decisionIds: [], inputs: [] },
          generate: async () =>
            await generateObjectForTask({
              dataClass: "customer",
              admission: modelAdmission,
              userId,
              organizationId,
              orgAIConfig,
              managedAIResidency,
              task: "short-text",
              serviceTier: "standard",
              analytics,
              caching: resolveCaching({
                promptCachingEnabled,
                task: "short-text",
                scopeKey: null,
              }),
              tenantWorkspaceIds: [],
              abortSignal: actionSignal,
              deadlineMs: CLEANUP_DEADLINE_MS,
              systemPromptOrigin: "server-built",
              system: DICTATION_CLEANUP_SYSTEM_PROMPT,
              prompt: buildDictationCleanupPrompt(
                vocabulary === undefined ? body : { ...body, vocabulary },
              ),
              outputSchema: dictationCleanupModelOutputSchema,
              outputTokenBudget: CLEANUP_OUTPUT_TOKENS,
            }),
        }),
      catch: (cause: unknown) => cause,
    });
    const output = yield* generated
      .andThen((artefact) => artefact.map(readUnsourcedArtefact))
      .mapError((cause) => {
        analytics.captureError(cause);
        return aiHandlerError(cause, {
          status: 502,
          message: "Dictation cleanup failed",
        });
      });
    const accepted = acceptDictationCleanup(output, body.transcript);
    if (accepted.isErr()) {
      // The reason only, never the text that caused it.
      analytics.captureError(
        classifyFailure(
          new HandlerError({
            status: 502,
            code: "internal_error",
            message: `Dictation cleanup answer refused: ${accepted.error}`,
          }),
          "response_invalid",
        ),
      );
      return Result.err(
        classifyFailure(
          new HandlerError({
            status: 502,
            code: "internal_error",
            message: "Dictation cleanup failed validation",
          }),
          "response_invalid",
        ),
      );
    }
    return Result.ok(accepted.value);
  });

/** The model call a test puts in place of the organization's model. */
export type DictationCleanupGeneration = Pick<
  DictationCleanupOptions,
  "generateObjectForTask" | "readVocabulary"
>;

type DictationCleanupEndpointOptions = DictationCleanupGeneration & {
  authorizeAccount?: typeof authorizeDesktopAccount;
  loadAISettings?: typeof loadOrgAISettings;
  limit?: typeof consumeDictationLimit;
  admit?: typeof withActionAdmission;
};

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
  authorizeAccount = authorizeDesktopAccount,
  loadAISettings = loadOrgAISettings,
  limit = consumeDictationLimit,
  admit,
  ...generation
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
        const { request, body } = ctx;
        const account = yield* Result.await(authorizeAccount(request));
        if (
          !isFeatureEnabled(
            account.featureAccessSnapshot,
            REQUIRED_FEATURE_ID,
            account,
          )
        ) {
          return Result.err(
            new HandlerError({
              status: 403,
              message: "Dictation is unavailable",
            }),
          );
        }
        if (!hasMemberPermission(account.memberRole, { chat: ["create"] })) {
          return Result.err(
            new HandlerError({
              status: 403,
              message: "AI use is not permitted",
            }),
          );
        }
        yield* Result.await(
          limit({
            organizationId: account.organizationId,
            userId: account.userId,
            operation: "cleanup",
          }),
        );
        const safeDb = safeDbFromScoped(account.scopedDb);
        const aiSettings = yield* Result.await(
          safeDb(
            async (tx) =>
              await loadAISettings(tx, {
                organizationId: account.organizationId,
                userId: account.userId,
              }),
          ),
        );
        const { orgAIConfig, managedAIResidency, promptCachingEnabled } =
          yield* aiSettings;
        const authorization = yield* Result.await(
          authorizeHandlerUsage({
            metering: { actionType: "chat", modelTask: "short-text" },
            organizationId: account.organizationId,
            userId: account.userId,
            safeDb,
            orgAIConfig,
            workspaceId: null,
          }),
        );
        return await authorization.execute(
          async () =>
            await Result.gen(async function* () {
              return yield* admitFiniteAction({
                actionKind: "dictation.cleanup",
                ctx: {
                  ...ctx,
                  user: { id: account.userId },
                  session: { activeOrganizationId: account.organizationId },
                  scopedDb: account.scopedDb,
                  actionSignal: request.signal,
                },
                ...(admit ? { admit } : {}),
                async *handler({ actionSignal, modelAdmission }) {
                  const segments = yield* Result.await(
                    cleanUpDictation({
                      caller: {
                        organizationId: account.organizationId,
                        userId: account.userId,
                        safeDb,
                        orgAIConfig,
                        managedAIResidency,
                        promptCachingEnabled,
                      },
                      body,
                      modelAdmission,
                      actionSignal,
                      ...generation,
                    }),
                  );
                  return Result.ok(segments);
                },
              });
            }),
        );
      },
    ),
    {
      type: "independent",
      reason:
        "Returns transient typed text for one dictation and stores nothing; the action-admission lifecycle owns model usage accounting.",
    },
  );

export default createDictationCleanupEndpoint();
