import { Result, TaggedError } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";

// The transport for endpoints the operator configured in the API environment,
// such as a telemetry collector. The logger reaches it through the log
// exporter, so it imports nothing beyond the fetch client: every module that
// logs, public routes included, would carry whatever it imports.

/** An operator endpoint that could not be reached or did not answer in time. */
export class OperatorEndpointError extends TaggedError(
  "OperatorEndpointError",
)<{
  cause: unknown;
  message: string;
}> {}

/** What an operator endpoint answered; its body is released unread. */
type OperatorEndpointResponse = {
  headers: Headers;
  ok: boolean;
  status: number;
};

/**
 * POST to an endpoint the operator configured in the API environment. No
 * request selects these URLs and they may sit on a private network, so the
 * address checks of safe-outbound-fetch.ts do not apply; the
 * operator-endpoint-transport ownership row confines the callers. Only the
 * status and headers are read and the body is released unread, so the
 * timeout bounds the wait for the response headers.
 */
export const postToOperatorEndpoint = async ({
  body,
  headers,
  timeout,
  url,
}: {
  body: string | Uint8Array;
  headers: Readonly<Record<string, string>>;
  timeout: { type: "headers"; ms: number };
  url: string;
}): Promise<Result<OperatorEndpointResponse, OperatorEndpointError>> => {
  const sent = await Result.tryPromise({
    try: async () => {
      // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- an operator-configured endpoint from the API environment; the operator-endpoint-transport ownership row confines the callers, and no request selects the URL
      const response = await fetchWithTimeout(url, {
        body,
        headers,
        method: "POST",
        timeout,
      });
      await response.body?.cancel();
      return response;
    },
    catch: (cause) =>
      new OperatorEndpointError({
        message: "Operator endpoint request failed",
        cause,
      }),
  });
  if (Result.isError(sent)) {
    return Result.err(sent.error);
  }
  const { headers: responseHeaders, ok, status } = sent.value;
  return Result.ok({ headers: responseHeaders, ok, status });
};
