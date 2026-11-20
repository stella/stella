import { Result } from "better-result";
import type * as v from "valibot";

import type { ModelTask } from "@stll/ai-catalog";
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
  admitFiniteAction,
  authorizeHandlerUsage,
  type SafeHandlerGenerator,
  type SafeHandlerLogContext,
} from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";

/**
 * What the dictation cleanups share: one model generation whose answer is
 * kept only when the caller's acceptance check passes, and the gate a
 * linked desktop passes before one (its dictation feature decision, a role
 * that may use AI, the cleanup budget, usage and the action admission).
 * Neither the text sent nor the answer is stored or logged.
 */

const GENERATOR = "apps/api/src/handlers/dictation/model-endpoint.ts";
const REQUIRED_FEATURE_ID = "desktop-dictation" satisfies DesktopFeatureId;

/** Who a cleanup runs for, with the organization's AI settings. */
export type DictationModelCaller = OrgAISettings & {
  readonly organizationId: SafeId<"organization">;
  readonly userId: SafeId<"user">;
  readonly safeDb: SafeDb;
};

/** The model call a test puts in place of the organization's model. */
export type DictationGeneration = {
  generateObjectForTask?: typeof generateTanStackObjectForTask;
};

type DictationAnswerOptions<
  TSchema extends v.GenericSchema,
  TAnswer,
  TRejection extends string,
> = DictationGeneration & {
  caller: DictationModelCaller;
  /** The admission the caller's action admission granted this cleanup. */
  modelAdmission: ModelDispatchAdmission;
  actionSignal: AbortSignal;
  /** The analytics feature, and the name failures carry. */
  feature: string;
  failureName: string;
  task: ModelTask;
  deadlineMs: number;
  outputTokenBudget: number;
  system: string;
  prompt: string;
  outputSchema: TSchema;
  /** The answer as the client receives it, or why it is refused. */
  accept: (output: v.InferOutput<TSchema>) => Result<TAnswer, TRejection>;
};

/**
 * One cleanup generation, whichever credential proved its caller: the text
 * goes to the organization's model for `task`, and its answer is returned
 * only when `accept` takes it; a refused answer is a 502 that names the
 * reason in analytics, never the text. The caller has already authorized
 * the member, the limit, usage and the action.
 */
export const generateDictationAnswer = async <
  TSchema extends v.GenericSchema,
  TAnswer,
  TRejection extends string,
>({
  caller,
  modelAdmission,
  actionSignal,
  feature,
  failureName,
  task,
  deadlineMs,
  outputTokenBudget,
  system,
  prompt,
  outputSchema,
  accept,
  generateObjectForTask = generateTanStackObjectForTask,
}: DictationAnswerOptions<TSchema, TAnswer, TRejection>) =>
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
      feature,
      modelTask: task,
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
    const generated = await Result.tryPromise({
      try: async () =>
        await generateArtefact({
          generator: GENERATOR,
          // The request carries the text itself; no stored record or
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
              task,
              serviceTier: "standard",
              analytics,
              caching: resolveCaching({
                promptCachingEnabled,
                task,
                scopeKey: null,
              }),
              tenantWorkspaceIds: [],
              abortSignal: actionSignal,
              deadlineMs,
              systemPromptOrigin: "server-built",
              system,
              prompt,
              outputSchema,
              outputTokenBudget,
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
          message: `${failureName} failed`,
        });
      });
    const accepted = accept(output);
    if (accepted.isErr()) {
      // The reason only, never the text that caused it.
      analytics.captureError(
        classifyFailure(
          new HandlerError({
            status: 502,
            code: "internal_error",
            message: `${failureName} answer refused: ${accepted.error}`,
          }),
          "response_invalid",
        ),
      );
      return Result.err(
        classifyFailure(
          new HandlerError({
            status: 502,
            code: "internal_error",
            message: `${failureName} failed validation`,
          }),
          "response_invalid",
        ),
      );
    }
    return Result.ok(accepted.value);
  });

/** What a test puts in place of the desktop's account, settings, budget
 *  and admission. */
export type DesktopDictationGate = {
  authorizeAccount?: typeof authorizeDesktopAccount;
  loadAISettings?: typeof loadOrgAISettings;
  limit?: typeof consumeDictationLimit;
  admit?: typeof withActionAdmission;
};

/** What an admitted desktop cleanup runs with. */
type AdmittedDictationContext = {
  caller: DictationModelCaller;
  actionSignal: AbortSignal;
  modelAdmission: ModelDispatchAdmission;
};

/** The same bound `admitFiniteAction` puts on its handler: admitted work
 *  answers data, never a raw `Response`. */
type FiniteResultGuard<TResult> = [Extract<TResult, Response>] extends [never]
  ? unknown
  : never;

/**
 * Runs one model-backed cleanup for a linked desktop: the account must hold
 * the dictation feature decision and a role that may use AI, the cleanup
 * budget is consumed, the organization's usage is authorized for `modelTask`,
 * and the cleanup runs under the "dictation.cleanup" action admission.
 */
export const runDesktopDictationModelAction = async function* <
  TResult extends NonNullable<unknown>,
>({
  ctx,
  modelTask,
  gate: {
    authorizeAccount = authorizeDesktopAccount,
    loadAISettings = loadOrgAISettings,
    limit = consumeDictationLimit,
    admit,
  },
  handler,
}: {
  ctx: SafeHandlerLogContext;
  modelTask: ModelTask;
  gate: DesktopDictationGate;
  handler: ((
    admitted: AdmittedDictationContext,
  ) => SafeHandlerGenerator<TResult>) &
    NoInfer<FiniteResultGuard<TResult>>;
}): SafeHandlerGenerator<TResult> {
  const { request } = ctx;
  const account = yield* Result.await(authorizeAccount(request));
  if (
    !isFeatureEnabled(
      account.featureAccessSnapshot,
      REQUIRED_FEATURE_ID,
      account,
    )
  ) {
    return Result.err(
      new HandlerError({ status: 403, message: "Dictation is unavailable" }),
    );
  }
  if (!hasMemberPermission(account.memberRole, { chat: ["create"] })) {
    return Result.err(
      new HandlerError({ status: 403, message: "AI use is not permitted" }),
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
      metering: { actionType: "chat", modelTask },
      organizationId: account.organizationId,
      userId: account.userId,
      safeDb,
      orgAIConfig,
      workspaceId: null,
    }),
  );
  const caller: DictationModelCaller = {
    organizationId: account.organizationId,
    userId: account.userId,
    safeDb,
    orgAIConfig,
    managedAIResidency,
    promptCachingEnabled,
  };
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
            caller,
          },
          ...(admit ? { admit } : {}),
          handler,
        });
      }),
  );
};
