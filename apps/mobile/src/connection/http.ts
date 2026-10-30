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
 * deadline for one that does not. The response is the platform's own,
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
  const deadline = () =>
    new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason);
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => {
          reject(controller.signal.reason);
        },
        { once: true },
      );
    });
  const bounded = async <T>(read: Promise<T>): Promise<T> =>
    await Promise.race([read, deadline()]).finally(clear);
  // The ways the app reads a body, each held to the deadline.
  const readers = {
    arrayBuffer: async () => await bounded(response.arrayBuffer()),
    blob: async () => await bounded(response.blob()),
    json: async (): Promise<unknown> => await bounded(response.json()),
    text: async () => await bounded(response.text()),
  } satisfies Partial<Response>;
  const isReader = (property: PropertyKey): property is keyof typeof readers =>
    Object.hasOwn(readers, property);
  return new Proxy(response, {
    get(target, property) {
      if (isReader(property)) {
        return readers[property];
      }
      const value: unknown = Reflect.get(target, property, target);
      // A method reads the platform response's own state, so it runs on it
      // rather than on the proxy.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

/**
 * A URL, or null when `input` is not one. Not `URL.parse`: that static is
 * newer than the URL implementation every React Native runtime ships.
 */
export const parseUrl = (input: string): URL | null => {
  const parsed = Result.try(() => new URL(input));
  return Result.isOk(parsed) ? parsed.value : null;
};
