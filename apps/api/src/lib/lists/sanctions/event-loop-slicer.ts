const DEFAULT_SLICE_MS = 10;

/**
 * Lets a long CPU pass on the serving event loop give way to requests. Call
 * the returned pause between units of work; once the current slice has run
 * for `sliceMs` it waits for a macrotask turn, so timers and I/O run before
 * the pass continues. An `await` on a resolved promise is not enough: it runs
 * as a microtask and never lets anything else in.
 */
export const createEventLoopSlicer = ({
  sliceMs = DEFAULT_SLICE_MS,
}: { sliceMs?: number } = {}): (() => Promise<void>) => {
  let sliceStartedAt = performance.now();
  return async () => {
    if (performance.now() - sliceStartedAt < sliceMs) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    sliceStartedAt = performance.now();
  };
};
