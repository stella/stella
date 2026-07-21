export type ToolCallTiming =
  | { status: "running"; startedAt: number }
  | { status: "finished"; durationMs: number | undefined };

export const createToolCallTiming = ({
  durationMs,
  isRunning,
  now,
}: {
  durationMs: number | undefined;
  isRunning: boolean;
  now: number;
}): ToolCallTiming => {
  if (isRunning) {
    return { status: "running", startedAt: now };
  }

  return { status: "finished", durationMs };
};

export const advanceToolCallTiming = ({
  current,
  durationMs,
  isRunning,
  now,
}: {
  current: ToolCallTiming;
  durationMs: number | undefined;
  isRunning: boolean;
  now: number;
}): ToolCallTiming => {
  if (isRunning) {
    return current.status === "running"
      ? current
      : { status: "running", startedAt: now };
  }

  if (current.status === "finished") {
    return current;
  }

  return {
    status: "finished",
    durationMs: durationMs ?? Math.max(0, now - current.startedAt),
  };
};
