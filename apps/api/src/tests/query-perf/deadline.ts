import { TimeoutError, withTimeout } from "@stll/concurrency/with-timeout";

import type { QueryPerfProfileId } from "./profiles";

const QUERY_PERF_PROFILE_DEADLINE_MS = 150_000;
const QUERY_PERF_DEADLINE_LABEL = "query-perf-profile-deadline";

type QueryPerfDeadlineOptions = {
  profileId: QueryPerfProfileId;
  timeoutMs?: number | undefined;
  now?: () => number;
};

/** All profile phases spend one deadline; adding entries cannot extend the suite. */
export const createQueryPerfDeadline = ({
  profileId,
  timeoutMs = QUERY_PERF_PROFILE_DEADLINE_MS,
  now = () => performance.now(),
}: QueryPerfDeadlineOptions) => {
  const expiresAt = now() + timeoutMs;
  return {
    run: async <T>(phase: string, operation: () => Promise<T>) => {
      const messageLabel = `query perf ${profileId}: ${phase}`;
      const remainingMs = expiresAt - now();
      process.stdout.write(
        `${JSON.stringify({
          event: "query_perf_phase",
          profileId,
          phase,
          status: "start",
          remainingMs,
        })}\n`,
      );
      try {
        if (remainingMs <= 0) {
          throw new TimeoutError({
            message: `${messageLabel} exceeded profile deadline ${timeoutMs}ms`,
            label: QUERY_PERF_DEADLINE_LABEL,
            timeoutMs,
          });
        }
        const value = await withTimeout(operation, {
          label: QUERY_PERF_DEADLINE_LABEL,
          timeoutMs: remainingMs,
        }).catch((error: unknown) => {
          // The label stays static; the message names the phase it cut.
          throw error instanceof TimeoutError &&
            error.label === QUERY_PERF_DEADLINE_LABEL
            ? new TimeoutError({
                message: `${messageLabel} exceeded ${String(error.timeoutMs)}ms`,
                label: QUERY_PERF_DEADLINE_LABEL,
                timeoutMs: error.timeoutMs,
                cause: error,
              })
            : error;
        });
        process.stdout.write(
          `${JSON.stringify({
            event: "query_perf_phase",
            profileId,
            phase,
            status: "done",
          })}\n`,
        );
        return value;
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({
            event: "query_perf_phase",
            profileId,
            phase,
            status: "failed",
            error: String(error),
          })}\n`,
        );
        throw error;
      }
    },
  };
};

export type QueryPerfDeadline = ReturnType<typeof createQueryPerfDeadline>;
