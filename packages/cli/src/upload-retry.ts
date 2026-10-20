import { setTimeout as sleep } from "node:timers/promises";

const ADVISED_RETRY_MAX_ATTEMPTS = 5;
const ADVISED_RETRY_MAX_DELAY_MS = 30_000;

export type UploadRetryDecision =
  | { type: "retry"; delayMs: number }
  | { type: "give-up" };

/** Pure retry policy mirrored from the server-side concurrency package. */
export const uploadRetryDecision = ({
  attempt,
  advisedDelayMs,
}: {
  attempt: number;
  advisedDelayMs?: number | undefined;
}): UploadRetryDecision => {
  if (attempt >= ADVISED_RETRY_MAX_ATTEMPTS) {
    return { type: "give-up" };
  }
  const floor = Math.min(1000 * 2 ** (attempt - 1), ADVISED_RETRY_MAX_DELAY_MS);
  return {
    type: "retry",
    delayMs: Math.min(
      ADVISED_RETRY_MAX_DELAY_MS,
      Math.max(floor, advisedDelayMs ?? 0),
    ),
  };
};

export { sleep };
