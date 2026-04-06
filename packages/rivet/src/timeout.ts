type WithTimeoutOptions<T> = {
  timeoutMs: number;
  timeoutMessage: string;
  signal?: AbortSignal | undefined;
  run: () => Promise<T>;
};

const toAbortError = ({
  combined,
  timeout,
  timeoutMessage,
}: {
  combined: AbortSignal;
  timeout: AbortSignal;
  timeoutMessage: string;
}) => {
  if (timeout.aborted) {
    return new Error(timeoutMessage);
  }

  const reason: unknown = combined.reason;
  if (reason instanceof Error) {
    return reason;
  }

  if (
    typeof reason === "string" ||
    typeof reason === "number" ||
    typeof reason === "boolean" ||
    typeof reason === "bigint"
  ) {
    return new Error(String(reason));
  }

  return new Error("aborted");
};

export const withTimeout = async <T>({
  timeoutMs,
  timeoutMessage,
  signal,
  run,
}: WithTimeoutOptions<T>): Promise<T> => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  if (combined.aborted) {
    throw toAbortError({ combined, timeout, timeoutMessage });
  }

  return await new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(toAbortError({ combined, timeout, timeoutMessage }));
    const cleanup = () => {
      combined.removeEventListener("abort", abort);
    };

    combined.addEventListener("abort", abort, { once: true });

    void run()
      .then((value) => {
        cleanup();
        resolve(value);
      })
      .catch((error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
};
