/**
 * `wrong-deployment`: readiness answered for another commit or environment,
 * which no recovery makes the proved deployment again.
 */
export type ReadinessSample =
  | { status: "ready" }
  | { status: "not-ready" }
  | { status: "wrong-deployment" };

export type ReadinessSource = (options: {
  timeoutMs: number;
}) => Promise<ReadinessSample>;

type ReadinessOptions = {
  read: ReadinessSource;
  now: () => number;
  sleep: (durationMs: number) => Promise<void>;
  deadlineMs: number;
  intervalMs: number;
  readTimeoutMs: number;
  /**
   * How long readiness may stay away before the proof counts as interrupted.
   * A replaced task that comes back serving the same deployment within it is
   * a recovered gap, not an interruption.
   */
  gapToleranceMs: number;
};

export type ReadinessMonitorOutcome =
  | { status: "ready"; recoveredGapsMs: readonly number[] }
  | { status: "environment-interrupted" };

type ReadinessMonitorOptions = ReadinessOptions & {
  signal: AbortSignal;
};

export const monitorStagingReadiness = async ({
  read,
  now,
  sleep,
  deadlineMs,
  intervalMs,
  readTimeoutMs,
  gapToleranceMs,
  signal,
}: ReadinessMonitorOptions): Promise<ReadinessMonitorOutcome> => {
  const proofFinished = () => signal.aborted;
  const recoveredGapsMs: number[] = [];
  let gapStartedAt: number | undefined;
  while (now() < deadlineMs) {
    const finalCheck = proofFinished();
    const sample = await read({
      timeoutMs: Math.min(readTimeoutMs, deadlineMs - now()),
    });
    if (sample.status === "wrong-deployment" || now() >= deadlineMs) {
      return { status: "environment-interrupted" };
    }
    if (sample.status === "not-ready") {
      gapStartedAt ??= now();
      if (now() - gapStartedAt > gapToleranceMs) {
        return { status: "environment-interrupted" };
      }
    } else {
      if (gapStartedAt !== undefined) {
        recoveredGapsMs.push(now() - gapStartedAt);
        gapStartedAt = undefined;
      }
      if (finalCheck) {
        return { status: "ready", recoveredGapsMs };
      }
      if (proofFinished()) {
        continue;
      }
    }
    await sleep(Math.min(intervalMs, deadlineMs - now()));
  }
  return { status: "environment-interrupted" };
};
