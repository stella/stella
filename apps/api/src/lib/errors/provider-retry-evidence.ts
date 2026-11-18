import type { TextOptions } from "@tanstack/ai";

import { NETWORK_ERROR_CODE_REASON } from "@/api/lib/observability/failure";
import { isRecord } from "@/api/lib/type-guards";

/** The response headers a retry decision reads (`provider-retry-policy.ts`). */
const RETRY_HEADERS = ["retry-after", "retry-after-ms", "x-should-retry"];

type RetryHintEvidence = {
  headers?: Record<string, string>;
  /** The provider's `x-should-retry` verdict. */
  isRetryable?: boolean;
};

/**
 * The retry hints a failed provider response carried: its retry headers,
 * and the provider's own verdict (`x-should-retry`) as `isRetryable`, the
 * fact `providerFailureFacts` keeps. Empty when it carried none.
 */
export const retryHintEvidence = (headers: Headers): RetryHintEvidence => {
  const hints = RETRY_HEADERS.flatMap((name) => {
    const value = headers.get(name);
    return value === null ? [] : [[name, value] as const];
  });
  if (hints.length === 0) {
    return {};
  }
  const verdict = headers.get("x-should-retry");
  return {
    headers: Object.fromEntries(hints),
    ...(verdict === "true" || verdict === "false"
      ? { isRetryable: verdict === "true" }
      : {}),
  };
};

/** Socket codes of a request that got no response, Bun's refusal included. */
export const PROVIDER_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(NETWORK_ERROR_CODE_REASON),
  "ConnectionRefused",
]);

/** How deep a rejected send is searched for its socket code. */
const TRANSPORT_CAUSE_DEPTH = 4;

/** The socket code of a send that got no response, if `error` names one. */
export const providerTransportCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < TRANSPORT_CAUSE_DEPTH && isRecord(current);
    depth += 1
  ) {
    const { code } = current;
    if (typeof code === "string" && PROVIDER_TRANSPORT_CODES.has(code)) {
      return code;
    }
    current = current["cause"];
  }
  return undefined;
};

const isAbortShaped = (error: unknown): boolean =>
  isRecord(error) &&
  (error["name"] === "AbortError" || error["name"] === "TimeoutError");

/**
 * What the last request of one adapter call left for the retry decision and
 * the failure report: the retry hints and request id of a failed response,
 * or the socket code of a request that got no response. None carries
 * request content.
 */
type ProviderSendEvidence = RetryHintEvidence & {
  code?: string;
  requestId?: string;
};

/** The request id a failed response names in its headers, if any. */
const responseRequestId = (headers: Headers): string | undefined => {
  const value = headers.get("x-request-id") ?? headers.get("request-id");
  return value === null || value === "" ? undefined : value;
};

/**
 * `evidence`, a failure's provider evidence, with what its last response
 * recorded: the retry hints join it, and the request id fills in where the
 * evidence names none of its own.
 */
export const withRecordedResponse = (
  evidence: Record<string, unknown>,
  recorded: ProviderSendEvidence,
): Record<string, unknown> => ({
  ...(recorded.requestId === undefined
    ? {}
    : { requestId: recorded.requestId }),
  ...evidence,
  ...(recorded.headers === undefined ? {} : { headers: recorded.headers }),
  ...(recorded.isRetryable === undefined
    ? {}
    : { isRetryable: recorded.isRetryable }),
});

/** Filled by {@link recordProviderSends} while one adapter call runs. */
export type ProviderSendRecord = { evidence: ProviderSendEvidence | undefined };

type FetchWrapper = NonNullable<TextOptions["wrapFetch"]>;

/**
 * A fetch wrapper (TanStack's per-call `wrapFetch`) that records what each
 * provider request of one adapter call came back with. A provider SDK keeps
 * a failed response's headers on its error, and a refused or reset
 * connection under its own error class, but TanStack's `RUN_ERROR`
 * projection forwards neither: this is where both are still at hand. An
 * abort the call itself did not ask for is the client's own timeout. Runs
 * innermost, under any wrapper the call already had.
 */
export const recordProviderSends =
  ({
    record,
    signal,
    outer,
  }: {
    record: ProviderSendRecord;
    signal: AbortSignal | undefined;
    outer: FetchWrapper | undefined;
  }): FetchWrapper =>
  (send) => {
    const recording: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        record.evidence = undefined;
        const sent = send(input, init);
        // Read what the request came back with on a side branch that never
        // rejects; the caller still gets the send itself, settled as it was.
        record.evidence = await sent.then(
          (response): ProviderSendEvidence | undefined => {
            if (response.ok) {
              return undefined;
            }
            const hints = retryHintEvidence(response.headers);
            const requestId = responseRequestId(response.headers);
            return hints.headers === undefined && requestId === undefined
              ? undefined
              : { ...hints, ...(requestId === undefined ? {} : { requestId }) };
          },
          (error: unknown): ProviderSendEvidence | undefined => {
            const code =
              providerTransportCode(error) ??
              (isAbortShaped(error) && signal?.aborted !== true
                ? "ETIMEDOUT"
                : undefined);
            return code === undefined ? undefined : { code };
          },
        );
        return await sent;
      },
      { preconnect: send.preconnect },
    );
    return outer === undefined ? recording : outer(recording);
  };

const evidenceBody = (body: unknown): Record<string, unknown> =>
  isRecord(body) ? body : {};

/**
 * `error`, a failure an adapter call threw, with the retry hints and request
 * id its last response carried joined to its evidence (`rawEvent`, what a
 * `RUN_ERROR` reads first, else its body). An error the record holds no
 * hint for is returned as it is.
 */
export const withSendEvidence = <TError>(
  error: TError,
  record: ProviderSendRecord,
): TError => {
  const hints = record.evidence;
  if (
    hints === undefined ||
    (hints.headers === undefined && hints.requestId === undefined) ||
    typeof error !== "object" ||
    error === null ||
    !Object.isExtensible(error)
  ) {
    return error;
  }
  const own: unknown = Reflect.get(error, "rawEvent");
  const body: unknown = Reflect.get(error, "error");
  const evidence = isRecord(own) ? own : evidenceBody(body);
  Object.defineProperty(error, "rawEvent", {
    configurable: true,
    value: withRecordedResponse(evidence, hints),
  });
  return error;
};
