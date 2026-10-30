import { Result } from "better-result";

/** The platform fetch, injected so tests and the API's end-to-end test own the network. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A phone on a bad network must give up rather than leave a screen spinning. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * `fetch` that aborts after `timeoutMs`, `REQUEST_TIMEOUT_MS` unless a slow
 * transfer names a longer one. Built on a controller and a timer rather than
 * `AbortSignal.timeout`, which not every React Native runtime provides.
 *
 * The deadline covers the body as well as the headers: the abort reaches a
 * `fetch` that honours its signal mid-body, and a body read races the
 * deadline for one that does not, as does a read of `body` itself. The
 * response is the platform's own,
 * behind a proxy, never rebuilt: on a phone the global `Response` is a
 * polyfill that cannot take a stream as its body and reads it as the text
 * "[object ReadableStream]".
 */
export const fetchWithTimeout = async (
  fetch: Fetch,
  input: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const clear = () => {
    clearTimeout(timer);
  };
  let receivedHeaders = false;
  const response = await fetch(input, {
    ...init,
    signal: controller.signal,
  })
    .then((value) => {
      receivedHeaders = true;
      return value;
    })
    .finally(() => {
      if (!receivedHeaders) {
        clear();
      }
    });
  if (response.body === null) {
    clear();
    return response;
  }
  // The abort's own reason (an `AbortError`), or one named the same way on a
  // runtime whose reason is not an Error.
  const abortReason = (): Error => {
    const reason: unknown = controller.signal.reason;
    return reason instanceof Error
      ? reason
      : Object.assign(new Error("The operation was aborted."), {
          name: "AbortError",
        });
  };
  const deadline = async () =>
    await new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(abortReason());
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => {
          reject(abortReason());
        },
        { once: true },
      );
    });
  const raced = async <T>(read: Promise<T>): Promise<T> =>
    await Promise.race([read, deadline()]);
  // The response and each clone of it is one body still open; the timer
  // stops when the last of them has been read, failed or been cancelled.
  let open = 0;
  const opened = () => {
    open += 1;
    let settled = false;
    return () => {
      if (settled) {
        return;
      }
      settled = true;
      open -= 1;
      if (open === 0) {
        clear();
      }
    };
  };
  // A caller that reads the stream itself gets one that errors at the
  // deadline, made when it first asks, so a `json()` caller never builds it.
  const boundStream = (
    source: ReadableStream<Uint8Array>,
    settle: () => void,
  ) => {
    // A cancel during a read ends that read, which holds the source's lock,
    // and the read cancels the source through its own reader.
    let cancelled = false;
    let cancelReason: unknown;
    let stop: ((reason: unknown) => void) | null = null;
    let pulling: Promise<void> | null = null;
    const pullOnce = async (
      stream: ReadableStreamDefaultController<Uint8Array>,
    ) => {
      // The reader is taken for one read and released after it, so the
      // source is never left locked between pulls.
      const reader = source.getReader();
      try {
        const stopped = new Promise<never>((_resolve, reject) => {
          stop = reject;
        });
        const next = await Result.tryPromise(
          async () => await Promise.race([raced(reader.read()), stopped]),
        );
        stop = null;
        if (cancelled) {
          await reader.cancel(cancelReason);
          return;
        }
        if (Result.isError(next)) {
          settle();
          stream.error(next.error.cause);
          await reader.cancel(next.error.cause);
          return;
        }
        if (next.value.done) {
          settle();
          stream.close();
          return;
        }
        stream.enqueue(next.value.value);
      } finally {
        reader.releaseLock();
      }
    };
    return new ReadableStream<Uint8Array>({
      async pull(stream) {
        pulling = pullOnce(stream);
        await pulling.finally(() => {
          pulling = null;
        });
      },
      async cancel(reason: unknown) {
        cancelled = true;
        cancelReason = reason;
        settle();
        if (stop === null || pulling === null) {
          await source.cancel(reason);
          return;
        }
        stop(reason);
        await pulling;
      },
    });
  };
  // Every way to consume the body is held to the deadline, on the response
  // and on each clone of it.
  const bind = (platform: Response): Response => {
    const settle = opened();
    const bounded = async <T>(read: Promise<T>): Promise<T> =>
      await raced(read).finally(settle);
    const readers = {
      arrayBuffer: async () => await bounded(platform.arrayBuffer()),
      blob: async () => await bounded(platform.blob()),
      clone: () => bind(platform.clone()),
      formData: async () => await bounded(platform.formData()),
      json: async (): Promise<unknown> => await bounded(platform.json()),
      text: async () => await bounded(platform.text()),
    };
    const isReader = (
      property: PropertyKey,
    ): property is keyof typeof readers => Object.hasOwn(readers, property);
    let body: ReadableStream<Uint8Array> | null | undefined;
    return new Proxy(platform, {
      get(target, property) {
        if (isReader(property)) {
          return readers[property];
        }
        if (property === "body") {
          body ??=
            target.body === null ? null : boundStream(target.body, settle);
          return body;
        }
        const value: unknown = Reflect.get(target, property, target);
        // A method reads the platform response's own state, so it runs on
        // it rather than on the proxy.
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return bind(response);
};

/**
 * A URL, or null when `input` is not one. Not `URL.parse`: that static is
 * newer than the URL implementation every React Native runtime ships.
 */
export const parseUrl = (input: string): URL | null => {
  const parsed = Result.try(() => new URL(input));
  return Result.isOk(parsed) ? parsed.value : null;
};
