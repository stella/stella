import { Result } from "better-result";

type RequestAutocompleteStreamOptions = {
  controller: AbortController;
  dispatchStart: () => boolean;
  fetchResponse: () => Promise<Response>;
};

export const requestAutocompleteStream = async ({
  controller,
  dispatchStart,
  fetchResponse,
}: RequestAutocompleteStreamOptions) => {
  if (!dispatchStart()) {
    controller.abort();
    return null;
  }
  return await fetchResponse();
};

type RunAutocompleteRequestOptions = RequestAutocompleteStreamOptions & {
  consume: (body: ReadableStream<Uint8Array>) => Promise<void>;
  clear: () => void;
  reportError: (error: unknown) => void;
};

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && error.name === "TimeoutError";

/**
 * Runs one autocomplete request end to end. An error response clears the
 * suggestion. A thrown request or stream error also clears it and goes to
 * `reportError`, except a request timeout, which only clears it. A cancelled
 * request (a newer edit or unmount aborts `controller`) settles nothing.
 */
export const runAutocompleteRequest = async ({
  consume,
  clear,
  reportError,
  ...request
}: RunAutocompleteRequestOptions): Promise<void> => {
  const result = await Result.tryPromise({
    try: async () => {
      const response = await requestAutocompleteStream(request);
      if (response === null) {
        return;
      }
      if (!response.ok || response.body === null) {
        clear();
        return;
      }
      await consume(response.body);
    },
    catch: (cause) => cause,
  });
  if (Result.isError(result) && !request.controller.signal.aborted) {
    clear();
    if (!isTimeoutError(result.error)) {
      reportError(result.error);
    }
  }
};
