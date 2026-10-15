import { panic, Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

import {
  ActionAdmissionError,
  actionAdmissionRefusal,
  withActionAdmission,
} from "./action-admission";
import type { ActionKind, AdmittedActionIdentity } from "./action-kinds";
import {
  admitModelDispatch,
  type ModelDispatchAdmission,
} from "./model-dispatch-admission";

const EXECUTION_ADMISSION_FAILURE = failureSink({
  event: "chat.execution.admission_lost",
  expected: [],
});

export type ExecutionAdmission = {
  signal: AbortSignal;
  /** The proof every model dispatch of this execution carries. */
  modelAdmission: ModelDispatchAdmission;
  reservePeriod: (
    identity: AdmittedActionIdentity,
    organizationStateDb?: ScopedDb,
  ) => Promise<Result<void, HandlerError>>;
  /** Release only after provider, fenced persistence and heartbeat work settle. */
  release: () => Promise<void>;
};

const executionAdmissionError = (error: unknown) => {
  if (ActionAdmissionError.is(error)) {
    return new HandlerError({ ...actionAdmissionRefusal(error), cause: error });
  }
  return new HandlerError({
    status: 503,
    code: "service_unavailable",
    message: "Action admission is unavailable",
    cause: error,
  });
};

type StartExecutionAdmissionOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** The organization's scope, read for the execution's managed model tier. */
  organizationStateDb: ScopedDb;
  /** Overrides the deployment flag `withActionAdmission` reads. */
  enabled?: boolean;
  admit?: typeof withActionAdmission;
} & (
  | {
      mode: "action";
      periodIdentity: AdmittedActionIdentity;
      actionKind?: never;
    }
  | { mode: "concurrency-only"; actionKind: ActionKind; periodIdentity?: never }
);

// Transport readiness and execution settlement are separate: returning a
// response cannot release the execution's lease. Continuations acquire anew.
// Disabled admission still yields an execution: `withActionAdmission` owns that
// decision and applies the demo account's daily budget either way.
export const startExecutionAdmission = async ({
  organizationId,
  userId,
  organizationStateDb,
  enabled,
  admit = withActionAdmission,
  mode,
  actionKind,
  periodIdentity,
}: StartExecutionAdmissionOptions): Promise<
  Result<ExecutionAdmission, HandlerError>
> => {
  const ready =
    Promise.withResolvers<Result<ExecutionAdmission, HandlerError>>();
  const finished = Promise.withResolvers<undefined>();
  const state: { status: "acquiring" | "executing" | "settled" } = {
    status: "acquiring",
  };
  const completion = admit({
    ...(enabled === undefined ? {} : { enabled }),
    scope: "independent",
    organizationId,
    userId,
    ...(mode === "action" ? { mode, periodIdentity } : { mode }),
    run: async (signal, control) =>
      // Minted while still acquiring: a failed tier read refuses the execution.
      await admitModelDispatch({
        organizationId,
        actionKind: mode === "action" ? periodIdentity.actionKind : actionKind,
        organizationStateDb,
        signal,
        run: async (modelAdmission) => {
          state.status = "executing";
          const loss = () =>
            observeFailure(signal.reason, {
              sink: EXECUTION_ADMISSION_FAILURE,
            });
          signal.addEventListener("abort", loss, { once: true });
          ready.resolve(
            Result.ok({
              signal,
              modelAdmission,
              reservePeriod: async (identity, reservationDb) => {
                const expectedKind =
                  mode === "action" ? periodIdentity.actionKind : actionKind;
                if (identity.actionKind !== expectedKind) {
                  panic("Chat reservation changed its action kind");
                }
                const reserved = await control.reservePeriod(
                  identity,
                  reservationDb,
                );
                return Result.isError(reserved)
                  ? Result.err(executionAdmissionError(reserved.error))
                  : Result.ok(reserved.value);
              },
              release: async () => {
                finished.resolve(undefined);
                await completion;
              },
            }),
          );
          try {
            await finished.promise;
          } finally {
            signal.removeEventListener("abort", loss);
          }
        },
      }),
  }).then((outcome) => {
    if (Result.isError(outcome)) {
      if (state.status === "acquiring") {
        ready.resolve(Result.err(executionAdmissionError(outcome.error)));
      } else {
        // Settlement already owns the durable outcome. Do not make it
        // retryable just because the ephemeral lease or its release failed.
        observeFailure(outcome.error, { sink: EXECUTION_ADMISSION_FAILURE });
      }
    }
    state.status = "settled";
    return undefined;
  });
  return await ready.promise;
};
