import { panic, Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  ActionAdmissionError,
  actionAdmissionRefusal,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import type { PeriodActionKind } from "@/api/lib/rate-limit/action-kinds";
import {
  admitModelDispatch,
  type ModelDispatchAdmission,
} from "@/api/lib/rate-limit/model-dispatch-admission";

// Background model work that failed after its caller already answered.
const BACKGROUND_FAILURE = failureSink({
  event: "model_action.background_failed",
  expected: [],
});

export type AdmittedModelAction = {
  signal: AbortSignal;
  admission: ModelDispatchAdmission;
};

/**
 * Runs model work as one admitted action, for code that decides on its own
 * whether a model call is needed (a save that derives text only when its
 * inputs changed). Inside an admitted request or tool call of the same member
 * it joins that action instead of drawing another.
 */
export type ModelActionAdmitter = <T>(
  run: (admitted: AdmittedModelAction) => Promise<T>,
) => Promise<Result<T, unknown>>;

type CreateModelActionAdmitterOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  organizationStateDb: ScopedDb;
  actionKind: PeriodActionKind;
  /** `independent` for work that outlives the caller's own admission. */
  scope?: "inherit" | "independent";
  admit?: typeof withActionAdmission;
};

export const createModelActionAdmitter =
  ({
    organizationId,
    userId,
    organizationStateDb,
    actionKind,
    scope,
    admit = withActionAdmission,
  }: CreateModelActionAdmitterOptions): ModelActionAdmitter =>
  async (run) =>
    await admit({
      organizationId,
      userId,
      organizationStateDb,
      ...(scope === undefined ? {} : { scope }),
      // No client idempotency key: each admitted run is its own action.
      periodIdentity: { actionKind, logicalPhaseId: Bun.randomUUIDv7() },
      run: async (signal) =>
        await admitModelDispatch({
          organizationId,
          actionKind,
          signal,
          run: async (admission) => await run({ signal, admission }),
        }),
    });

type DetachedModelActionOptions<TStarted> = {
  /** Runs admitted before the caller resumes; its value answers the caller. */
  start: (admitted: AdmittedModelAction) => Promise<TStarted>;
  /** Runs after the caller resumes; the action stays admitted until it settles. */
  background: (
    admitted: AdmittedModelAction,
    started: TStarted,
  ) => Promise<void>;
  /** Names the background work in failure capture. */
  label: string;
};

/**
 * Starts a model action whose model work continues after the caller answers
 * (a request that returns `generating` while the generation runs). Resolves
 * once `start` settles: a refusal or a `start` failure comes back to the
 * caller, and otherwise the admission stays held through `background`, so the
 * work never runs past its slot or its lease.
 */
export type DetachedModelActionStarter = <TStarted>(
  options: DetachedModelActionOptions<TStarted>,
) => Promise<Result<TStarted, unknown>>;

export const createDetachedModelActionStarter = (
  options: Omit<CreateModelActionAdmitterOptions, "scope">,
): DetachedModelActionStarter => {
  // The caller's own admission settles before the background work does, so
  // the work never joins it.
  const admitModelAction = createModelActionAdmitter({
    ...options,
    scope: "independent",
  });
  return async <TStarted>({
    start,
    background,
    label,
  }: DetachedModelActionOptions<TStarted>) => {
    const answered = Promise.withResolvers<Result<TStarted, unknown>>();
    const phase: { status: "starting" | "continuing" } = { status: "starting" };
    const run = async () => {
      const outcome = await admitModelAction(async (admitted) => {
        const started = await start(admitted);
        phase.status = "continuing";
        answered.resolve(Result.ok(started));
        await background(admitted, started);
      });
      if (Result.isOk(outcome)) {
        return;
      }
      switch (phase.status) {
        case "starting":
          answered.resolve(Result.err(outcome.error));
          return;
        case "continuing":
          // The caller already answered; the failure goes to capture.
          observeFailure(outcome.error, {
            sink: BACKGROUND_FAILURE,
            ctx: { operation: label },
          });
          return;
        default:
          phase.status satisfies never;
          panic("Unhandled detached model action phase");
      }
    };
    detached(run(), "model-action.background");
    return await answered.promise;
  };
};

/**
 * The answer for a model action that admission did not start: the refusal's
 * own contract, or an unavailable admission.
 */
export const modelActionRefusal = (
  error: unknown,
): HandlerError<403 | 429 | 503> =>
  ActionAdmissionError.is(error)
    ? new HandlerError({ ...actionAdmissionRefusal(error), cause: error })
    : new HandlerError({
        status: 503,
        code: "service_unavailable",
        message: "Action admission is unavailable",
        cause: error,
      });
