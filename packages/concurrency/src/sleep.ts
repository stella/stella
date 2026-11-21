type SleepOptions = {
  signal?: AbortSignal;
};

/** Wait for a delay; cancellation clears the timer and removes its listener. */
export const sleep = async (
  milliseconds: number,
  { signal }: SleepOptions = {},
): Promise<void> => {
  if (signal?.aborted) {
    signal.throwIfAborted();
  }
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal reasons may be arbitrary values; preserve the caller's exact cancellation reason.
      reject(signal?.reason);
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};
