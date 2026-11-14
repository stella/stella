import { TimeoutError, withTimeout } from "@stll/concurrency/with-timeout";

import type { QueryPerfProfileId } from "./profiles";

const QUERY_PERF_PROFILE_DEADLINE_MS = 150_000;

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
      const label = `query perf ${profileId}: ${phase}`;
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
            message: `${label} exceeded profile deadline ${timeoutMs}ms`,
            label,
            timeoutMs,
          });
        }
        const value = await withTimeout(operation, {
          label,
          timeoutMs: remainingMs,
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
