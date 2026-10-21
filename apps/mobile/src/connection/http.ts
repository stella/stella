import { Result } from "better-result";

/** The platform fetch, injected so tests and the API's end-to-end test own the network. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A phone on a bad network must give up rather than leave a screen spinning. */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * `fetch` that aborts after `REQUEST_TIMEOUT_MS`. Built on a controller and a
 * timer rather than `AbortSignal.timeout`, which not every React Native
 * runtime provides.
 */
export const fetchWithTimeout = async (
  fetch: Fetch,
  input: string,
  init: RequestInit = {},
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A URL, or null when `input` is not one. Not `URL.parse`: that static is
 * newer than the URL implementation every React Native runtime ships.
 */
export const parseUrl = (input: string): URL | null => {
  const parsed = Result.try(() => new URL(input));
  return Result.isOk(parsed) ? parsed.value : null;
};
