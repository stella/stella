import type { TextOptions } from "@tanstack/ai";
import { Result } from "better-result";

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
 * What the last request of one adapter call left for the retry decision:
 * the retry hints of a failed response, or the socket code of a request that
 * got no response. Neither carries request content.
 */
type ProviderSendEvidence = RetryHintEvidence & { code?: string };

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
        const sent = await Result.tryPromise(
          async () => await send(input, init),
        );
        if (Result.isError(sent)) {
          const error = sent.error.cause;
          const code =
            providerTransportCode(error) ??
            (isAbortShaped(error) && signal?.aborted !== true
              ? "ETIMEDOUT"
              : undefined);
          record.evidence = code === undefined ? undefined : { code };
          throw error;
        }
        const response = sent.value;
        if (!response.ok) {
          const hints = retryHintEvidence(response.headers);
          record.evidence = hints.headers === undefined ? undefined : hints;
        }
        return response;
      },
      { preconnect: send.preconnect },
    );
    return outer === undefined ? recording : outer(recording);
  };

/**
 * `error`, a failure an adapter call threw, with the retry hints its last
 * response carried as its evidence (`rawEvent`, what a `RUN_ERROR` reads
 * first). The body stays the evidence it was; the hints join it. An error
 * the record holds no hint for is returned as it is.
 */
export const withSendEvidence = <TError>(
  error: TError,
  record: ProviderSendRecord,
): TError => {
  const hints = record.evidence;
  if (
    hints === undefined ||
    hints.headers === undefined ||
    typeof error !== "object" ||
    error === null ||
    !Object.isExtensible(error)
  ) {
    return error;
  }
  const body: unknown = Reflect.get(error, "error");
  Object.defineProperty(error, "rawEvent", {
    configurable: true,
    value: {
      ...(isRecord(body) ? body : {}),
      headers: hints.headers,
      ...(hints.isRetryable === undefined
        ? {}
        : { isRetryable: hints.isRetryable }),
    },
  });
  return error;
};
