type Scheduled = { clear: () => void };

type Schedule = (run: () => void, delayMs: number) => Scheduled;

const scheduleTimeout: Schedule = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  return {
    clear: () => {
      clearTimeout(handle);
    },
  };
};

type OpenWithinDeadlineOptions<T> = {
  /** Starts the storage request; resolves once the response headers arrive. */
  open: (signal: AbortSignal) => Promise<T>;
  /** The caller's own cancellation, such as the client disconnecting. */
  signal: AbortSignal;
  timeoutMs: number;
  schedule?: Schedule;
};

/**
 * Bound a storage GET only until its headers arrive. The returned body keeps
 * streaming under the caller's signal alone: a deadline that outlived the
 * open would cut a valid long download off after its headers went out.
 */
export const openWithinDeadline = async <T>({
  open,
  signal,
  timeoutMs,
  schedule = scheduleTimeout,
}: OpenWithinDeadlineOptions<T>): Promise<T> => {
  const deadline = new AbortController();
  const timer = schedule(() => {
    deadline.abort(
      new DOMException("Storage did not answer in time", "TimeoutError"),
    );
  }, timeoutMs);
  try {
    return await open(AbortSignal.any([signal, deadline.signal]));
  } finally {
    timer.clear();
  }
};
