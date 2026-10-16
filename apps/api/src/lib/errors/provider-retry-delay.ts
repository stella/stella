import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { isRecord } from "@/api/lib/type-guards";

/**
 * The longest provider retry delay a caller waits out before trying once
 * more. A longer delay ends the call with the delay attached, so the caller
 * can say when to retry and must not regenerate before then.
 */
export const PROVIDER_RETRY_WAIT_CAP_MS = 30_000;

const RETRY_INFO_TYPE = "type.googleapis.com/google.rpc.RetryInfo";

// "12s", "11.5s", "0.062s": the protobuf Duration JSON form.
const DURATION = /^(\d+(?:\.\d+)?)s$/u;

// The delay providers state in prose: "Please retry in 12.53s.", "Please try
// again in 62ms.", "try again in 1.2 seconds".
const PROSE_DELAY =
  /\b(?:retry|try again) in (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:ond)?s?)\b/iu;

const durationMs = (value: unknown): number | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = DURATION.exec(value.trim());
  return match?.[1] === undefined
    ? undefined
    : Math.ceil(Number(match[1]) * 1000);
};

const proseDelayMs = (text: string): number | undefined => {
  const match = PROSE_DELAY.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  const amount = Number(match[1]);
  return Math.ceil(
    match[2].toLowerCase().startsWith("m") ? amount : amount * 1000,
  );
};

const headerValue = (headers: unknown, name: string): string | undefined => {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (isRecord(headers)) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
};

const headerDelayMs = (headers: unknown, now: number): number | undefined => {
  const milliseconds = headerValue(headers, "retry-after-ms");
  if (milliseconds !== undefined && /^\d+(?:\.\d+)?$/u.test(milliseconds)) {
    return Math.ceil(Number(milliseconds));
  }
  const retryAfter = headerValue(headers, "retry-after")?.trim();
  if (retryAfter === undefined || retryAfter === "") {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/u.test(retryAfter)) {
    return Math.ceil(Number(retryAfter) * 1000);
  }
  // HTTP-date is IMF-fixdate rather than an ISO Temporal grammar. Date is the
  // platform parser for this legacy protocol form.
  const date = new Date(retryAfter).getTime();
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

const responseHeaderDelayMs = (
  response: unknown,
  now: number,
): number | undefined => {
  if (response instanceof Response) {
    return headerDelayMs(response.headers, now);
  }
  return isRecord(response)
    ? headerDelayMs(response["headers"], now)
    : undefined;
};

// google.rpc.Status: `{ error: { details: [{ "@type": RetryInfo, retryDelay }] } }`,
// with or without the `error` envelope.
const retryInfoDelayMs = (
  body: Record<string, unknown>,
): number | undefined => {
  const status = isRecord(body["error"]) ? body["error"] : body;
  const details = status["details"];
  if (!Array.isArray(details)) {
    return undefined;
  }
  for (const detail of details) {
    if (isRecord(detail) && detail["@type"] === RETRY_INFO_TYPE) {
      const delay = durationMs(detail["retryDelay"]);
      if (delay !== undefined) {
        return delay;
      }
    }
  }
  return undefined;
};

const jsonBody = (text: string): unknown => {
  if (!text.trimStart().startsWith("{")) {
    return undefined;
  }
  return Result.try((): unknown => JSON.parse(text)).unwrapOr(undefined);
};

const messageOf = (node: Record<string, unknown>): string | undefined => {
  const error = node["error"];
  if (isRecord(error) && typeof error["message"] === "string") {
    return error["message"];
  }
  return typeof node["message"] === "string" ? node["message"] : undefined;
};

/**
 * How long the provider asked the caller to wait before retrying, in
 * milliseconds, from whatever the failure carries: a `retry-after-ms` or
 * `retry-after` header (on the error, its response or a cause), a
 * google.rpc `RetryInfo` detail, or the delay a provider message states.
 * Undefined when the provider named none. The structured sources win over
 * prose, and the walk follows `cause`, `error` and `rawResponse` links.
 */
export const providerRetryDelayMs = (
  evidence: unknown,
  now: number = Temporal.Now.instant().epochMilliseconds,
): number | undefined => {
  const seen = new Set<object>();
  const queue: unknown[] = [evidence];
  let prose: number | undefined;
  while (queue.length > 0) {
    const record = queue.shift();
    // Errors are records too; indexed reads also see their non-enumerable
    // `message` and `cause`.
    if (!isRecord(record) || seen.has(record)) {
      continue;
    }
    seen.add(record);
    const fromHeaders =
      headerDelayMs(record["headers"], now) ??
      responseHeaderDelayMs(record["rawResponse"] ?? record["response"], now);
    if (fromHeaders !== undefined) {
      return fromHeaders;
    }
    const fromRetryInfo = retryInfoDelayMs(record);
    if (fromRetryInfo !== undefined) {
      return fromRetryInfo;
    }
    const message = messageOf(record);
    if (message !== undefined) {
      // An SDK that rethrows the provider's JSON body as its message.
      queue.push(jsonBody(message));
      prose ??= proseDelayMs(message);
    }
    queue.push(record["cause"], record["error"], record["body"]);
  }
  return prose;
};
