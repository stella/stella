import { backoffDelay } from "./backoff-delay";

export const ADVISED_RETRY_MAX_ATTEMPTS = 5;
export const ADVISED_RETRY_MAX_DELAY_MS = 30_000;

export type AdvisedRetryDecision =
  | { type: "retry"; delayMs: number }
  | { type: "give-up" };

/** Decide whether a failed operation may be retried. Attempts are one-based. */
export const advisedRetry = ({
  attempt,
  advisedDelayMs,
}: {
  attempt: number;
  advisedDelayMs?: number | undefined;
}): AdvisedRetryDecision => {
  if (attempt >= ADVISED_RETRY_MAX_ATTEMPTS) {
    return { type: "give-up" };
  }
  const floor = backoffDelay(attempt - 1, {
    baseMs: 1000,
    maxMs: ADVISED_RETRY_MAX_DELAY_MS,
  });
  return {
    type: "retry",
    delayMs: Math.min(
      ADVISED_RETRY_MAX_DELAY_MS,
      Math.max(floor, advisedDelayMs ?? 0),
    ),
  };
};
