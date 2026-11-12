import { Result } from "better-result";

import {
  desktopDictationCleanupRequestSchema,
  desktopDictationCleanupResponseSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";
import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";
import { classifyFailure } from "@stll/errors";

import { safeDbFromScoped } from "@/api/db/safe-db";
import { consumeDictationLimit } from "@/api/handlers/dictation/limits";
import { resolveCaching } from "@/api/lib/ai-config";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { aiHandlerError } from "@/api/lib/ai-error";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  admitFiniteAction,
  authorizeHandlerUsage,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";

import {
  acceptDictationCleanup,
  buildDictationCleanupPrompt,
  DICTATION_CLEANUP_SYSTEM_PROMPT,
  dictationCleanupModelOutputSchema,
} from "./cleanup-model";

const REQUIRED_FEATURE_ID = "desktop-dictation" satisfies DesktopFeatureId;
/** The desktop stops waiting after about five seconds and types the raw
 *  transcript; a generation that outlives it would only spend usage. */
const CLEANUP_DEADLINE_MS = 5_000;
const CLEANUP_OUTPUT_TOKENS = 8_000;

type DictationCleanupEndpointOptions = {
  authorizeAccount?: typeof authorizeDesktopAccount;
  loadAISettings?: typeof loadOrgAISettings;
  limit?: typeof consumeDictationLimit;
  generateObjectForTask?: typeof generateTanStackObjectForTask;
  admit?: typeof withActionAdmission;
};

/**
 * Cleans up one desktop dictation: the text the computer transcribed, never
 * its audio, goes to the organization's model, which fixes recognition
 * mistakes and turns spoken punctuation and formatting commands into typed
 * segments. Neither the transcript nor the answer is stored or logged.
 */
export const createDictationCleanupEndpoint = ({
  authorizeAccount = authorizeDesktopAccount,
  loadAISettings = loadOrgAISettings,
  limit = consumeDictationLimit,
  generateObjectForTask = generateTanStackObjectForTask,
  admit,
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
                      organizationId: account.organizationId,
                      userId: account.userId,
                      safeDb,
                      serviceTier: "standard",
                      workspaceId: null,
                    },
                  });
                  const output = yield* Result.await(
                    Result.tryPromise({
                      try: async () =>
                        await generateObjectForTask({
                          dataClass: "customer",
                          admission: modelAdmission,
                          userId: account.userId,
                          organizationId: account.organizationId,
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
                          prompt: buildDictationCleanupPrompt(body),
                          outputSchema: dictationCleanupModelOutputSchema,
                          outputTokenBudget: CLEANUP_OUTPUT_TOKENS,
                        }),
                      catch: (cause) => {
                        analytics.captureError(cause);
                        return aiHandlerError(cause, {
                          status: 502,
                          message: "Dictation cleanup failed",
                        });
                      },
                    }),
                  );
                  const accepted = acceptDictationCleanup(
                    output,
                    body.transcript,
                  );
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
