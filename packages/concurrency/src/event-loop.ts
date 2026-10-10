const DEFAULT_SLICE_MS = 10;

/**
 * Waits for the next macrotask turn, so timers and I/O that are due run
 * first. An `await` on a resolved promise is not enough: it continues as a
 * microtask and never lets anything else in.
 */
export const nextMacrotask = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

/**
 * Lets a long CPU pass on a serving event loop give way to other work. Call
 * the returned pause between units of work; once the current slice has run
 * for `sliceMs` it waits for {@link nextMacrotask} and starts a new slice.
 */
export const createEventLoopSlicer = ({
  sliceMs = DEFAULT_SLICE_MS,
  now = () => performance.now(),
}: {
  sliceMs?: number;
  now?: () => number;
} = {}): (() => Promise<void>) => {
  let sliceStartedAt = now();
  return async () => {
    if (now() - sliceStartedAt < sliceMs) {
      return;
    }
    await nextMacrotask();
    sliceStartedAt = now();
  };
};
