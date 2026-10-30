export type ReadinessSample = { status: "ready" } | { status: "not-ready" };

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
};

export type ReadinessMonitorOutcome =
  { status: "ready" } | { status: "environment-interrupted" };

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
  signal,
}: ReadinessMonitorOptions): Promise<ReadinessMonitorOutcome> => {
  const proofFinished = () => signal.aborted;
  while (now() < deadlineMs) {
    const finalCheck = proofFinished();
    const sample = await read({
      timeoutMs: Math.min(readTimeoutMs, deadlineMs - now()),
    });
    if (sample.status === "not-ready" || now() >= deadlineMs) {
      return { status: "environment-interrupted" };
    }
    if (finalCheck) {
      return { status: "ready" };
    }
    if (proofFinished()) {
      continue;
    }
    await sleep(Math.min(intervalMs, deadlineMs - now()));
  }
  return { status: "environment-interrupted" };
};
