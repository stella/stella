export const abortableSleep = async (
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  signal.throwIfAborted();
  const abort = Promise.withResolvers<never>();
  const onAbort = (): void => {
    abort.reject(new Error("Reconciliation sleep aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  await Promise.race([sleep(ms), abort.promise]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
};
