import { Result } from "better-result";

import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  ActionAdmissionError,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import type { ActionPeriodIdentity } from "@/api/lib/rate-limit/action-period-budget";

const EXECUTION_ADMISSION_FAILURE = failureSink({
  event: "chat.execution.admission_lost",
  expected: [],
});

export type ChatExecutionAdmission = {
  signal: AbortSignal;
  reservePeriod: (
    identity: ActionPeriodIdentity,
  ) => Promise<Result<void, HandlerError>>;
  /** Release only after provider, fenced persistence and heartbeat work settle. */
  release: () => Promise<void>;
};

const chatAdmissionError = (error: unknown) => {
  const busy = ActionAdmissionError.is(error) && error.reason === "busy";
  return new HandlerError({
    status: busy ? 429 : 503,
    code: busy ? "rate_limited" : "service_unavailable",
    message: busy ? error.message : "Action admission is unavailable",
    cause: error,
  });
};

type StartChatExecutionAdmissionOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  enabled?: boolean;
  admit?: typeof withActionAdmission;
} & (
  | { mode: "action"; periodIdentity: ActionPeriodIdentity }
  | { mode: "concurrency-only"; periodIdentity?: never }
);

// Transport readiness and execution settlement are separate: returning a
// response cannot release the execution's lease. Continuations acquire anew.
export const startChatExecutionAdmission = async ({
  organizationId,
  userId,
  enabled = env.FEATURE_ACTION_ADMISSION,
  admit = withActionAdmission,
  mode,
  periodIdentity,
}: StartChatExecutionAdmissionOptions): Promise<
  Result<ChatExecutionAdmission | undefined, HandlerError>
> => {
  if (!enabled) {
    return Result.ok(undefined);
  }
  const ready =
    Promise.withResolvers<Result<ChatExecutionAdmission, HandlerError>>();
  const finished = Promise.withResolvers<undefined>();
  const state: { status: "acquiring" | "executing" | "settled" } = {
    status: "acquiring",
  };
  const completion = admit({
    enabled: true,
    scope: "independent",
    organizationId,
    userId,
    ...(mode === "action" ? { mode, periodIdentity } : { mode }),
    run: async (signal, control) => {
      state.status = "executing";
      const loss = () =>
        observeFailure(signal.reason, { sink: EXECUTION_ADMISSION_FAILURE });
      signal.addEventListener("abort", loss, { once: true });
      ready.resolve(
        Result.ok({
          signal,
          reservePeriod: async (identity) => {
            const reserved = await control.reservePeriod(identity);
            return Result.isError(reserved)
              ? Result.err(chatAdmissionError(reserved.error))
              : reserved;
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
  }).then((outcome) => {
    if (Result.isError(outcome)) {
      if (state.status === "acquiring") {
        ready.resolve(Result.err(chatAdmissionError(outcome.error)));
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
