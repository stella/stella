type NonOverlappingIntervalOptions = {
  intervalMs: number;
  onError: (error: unknown) => void;
  run: () => Promise<void>;
};

export const startNonOverlappingInterval = ({
  intervalMs,
  onError,
  run,
}: NonOverlappingIntervalOptions) => {
  let active: Promise<void> | null = null;
  let closing = false;

  const schedule = (): void => {
    if (closing || active !== null) {
      return;
    }
    active = run()
      .catch(onError)
      .finally(() => {
        active = null;
      });
  };

  schedule();
  const timer = setInterval(schedule, intervalMs);
  timer.unref();

  return async () => {
    closing = true;
    clearInterval(timer);
    if (active !== null) {
      await active;
    }
  };
};
