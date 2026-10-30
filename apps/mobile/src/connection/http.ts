import { Result } from "better-result";

/** The platform fetch, injected so tests and the API's end-to-end test own the network. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A phone on a bad network must give up rather than leave a screen spinning. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * `fetch` that aborts after `timeoutMs`, `REQUEST_TIMEOUT_MS` unless a slow
 * transfer names a longer one. Built on a controller and a timer rather than
 * `AbortSignal.timeout`, which not every React Native runtime provides.
 */
export const fetchWithTimeout = async (
  fetch: Fetch,
  input: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
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

  const reader = response.body.getReader();
  let stopped = false;
  let cancellation: Promise<void> | undefined;
  let abort = () => undefined;
  const finish = () => {
    stopped = true;
    clear();
    controller.signal.removeEventListener("abort", abort);
  };
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      abort = () => {
        if (stopped) {
          return;
        }
        finish();
        stream.error(controller.signal.reason);
        cancellation = reader.cancel(controller.signal.reason).then(
          () => reader.releaseLock(),
          () => reader.releaseLock(),
        );
      };
      controller.signal.addEventListener("abort", abort, { once: true });
    },
    async pull(stream) {
      if (stopped) {
        await cancellation;
        return;
      }
      await reader.read().then(
        ({ done, value }) => {
          if (stopped) {
            return undefined;
          }
          if (done) {
            finish();
            reader.releaseLock();
            stream.close();
            return undefined;
          }
          stream.enqueue(value);
          return undefined;
        },
        (error: unknown) => {
          if (stopped) {
            return undefined;
          }
          finish();
          reader.releaseLock();
          stream.error(error);
          return undefined;
        },
      );
      await cancellation;
    },
    async cancel(reason: unknown) {
      if (stopped) {
        await cancellation;
        return;
      }
      finish();
      await reader.cancel(reason).finally(() => reader.releaseLock());
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return wrapped;
};

/**
 * A URL, or null when `input` is not one. Not `URL.parse`: that static is
 * newer than the URL implementation every React Native runtime ships.
 */
export const parseUrl = (input: string): URL | null => {
  const parsed = Result.try(() => new URL(input));
  return Result.isOk(parsed) ? parsed.value : null;
};
