type NonOverlappingIntervalOptions = {
  /** Delay before the first run; the first run is immediate without one. */
  initialDelayMs?: number;
  intervalMs: number;
  onError: (error: unknown) => void;
  run: () => Promise<void>;
};

export const startNonOverlappingInterval = ({
  initialDelayMs = 0,
  intervalMs,
  onError,
  run,
}: NonOverlappingIntervalOptions) => {
  let active: Promise<void> | null = null;
  let closing = false;
  let timer: ReturnType<typeof setInterval> | undefined;

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

  const start = (): void => {
    schedule();
    timer = setInterval(schedule, intervalMs);
    timer.unref();
  };

  let delay: ReturnType<typeof setTimeout> | undefined;
  if (initialDelayMs > 0) {
    delay = setTimeout(start, initialDelayMs);
    delay.unref();
  } else {
    start();
  }

  return async () => {
    closing = true;
    clearTimeout(delay);
    clearInterval(timer);
    if (active !== null) {
      await active;
    }
  };
};
