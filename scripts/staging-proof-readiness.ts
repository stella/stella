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

export type ReadinessGateOutcome =
  { status: "ready" } | { status: "environment-unavailable" };

export type ReadinessMonitorOutcome =
  { status: "ready" } | { status: "environment-interrupted" };

// The source enforces its timeout and converts failed reads to not-ready samples.
export const waitForStagingReadiness = async ({
  read,
  now,
  sleep,
  deadlineMs,
  intervalMs,
  readTimeoutMs,
}: ReadinessOptions): Promise<ReadinessGateOutcome> => {
  while (now() < deadlineMs) {
    const sample = await read({
      timeoutMs: Math.min(readTimeoutMs, deadlineMs - now()),
    });
    if (now() >= deadlineMs) {
      return { status: "environment-unavailable" };
    }
    if (sample.status === "ready") {
      return { status: "ready" };
    }
    await sleep(Math.min(intervalMs, deadlineMs - now()));
  }
  return { status: "environment-unavailable" };
};

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
