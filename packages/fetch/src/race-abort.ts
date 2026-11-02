const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted", "AbortError");

// Detaches its listener once either side settles, so a long-lived signal does
// not retain the raced operation.
export const raceAbort = async <T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  if (signal === undefined) {
    return await work;
  }
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(abortReason(signal));
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};
