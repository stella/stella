import { panic, Result, TaggedError } from "better-result";
import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction, TcpSocketConnectOpts } from "node:net";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { withTimeout } from "@/api/lib/with-timeout";

export class SafeOutboundFetchError extends TaggedError(
  "SafeOutboundFetchError",
)<{
  cause?: unknown;
  message: string;
}> {}

export type SafeOutboundAddress = {
  address: string;
  family: 4 | 6;
};

const MAX_OUTBOUND_URL_LENGTH = 2048;

export type SafeOutboundFetchBody =
  | ArrayBuffer
  | string
  | Uint8Array
  | URLSearchParams;
export type SafeOutboundHeaders = Headers | Record<string, string>;

export type SafeOutboundFetchResponse = {
  body: ArrayBuffer;
  headers: Headers;
  ok: boolean;
  status: number;
};

export type SafeOutboundFetchStreamResponse = {
  body: ReadableStream<Uint8Array>;
  headers: Headers;
  ok: boolean;
  status: number;
};

type RequestGuards = {
  clearHeaderTimeout: () => void;
  cleanup: () => void;
};

const attachRequestGuards = ({
  reject,
  request,
  signal,
  timeoutMs,
}: {
  reject: (reason?: unknown) => void;
  request: ClientRequest;
  signal: AbortSignal | undefined;
  timeoutMs: number;
}): RequestGuards | null => {
  const timeout = setTimeout(() => {
    request.destroy(
      new SafeOutboundFetchError({ message: "Request timed out" }),
    );
  }, timeoutMs);
  const abort = () => {
    request.destroy(abortReasonToError(signal?.reason));
  };
  const cleanup = () => {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
  };
  request.on("error", (cause) => {
    cleanup();
    reject(cause);
  });
  request.on("close", cleanup);
  if (signal?.aborted) {
    const error = abortReasonToError(signal.reason);
    clearTimeout(timeout);
    request.destroy(error);
    reject(error);
    return null;
  }
  signal?.addEventListener("abort", abort, { once: true });
  return { clearHeaderTimeout: () => clearTimeout(timeout), cleanup };
};

type SafeOutboundRedirectMode = "error" | "manual";

// The caller vetted this whole set together. Keep it pinned while allowing
// Happy Eyeballs to select a reachable family without another DNS lookup.
const createPinnedLookup =
  ({
    addresses,
    primaryAddress,
  }: {
    addresses: readonly SafeOutboundAddress[];
    primaryAddress: SafeOutboundAddress;
  }): LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all === true) {
      callback(
        null,
        addresses.map(({ address, family }) => ({ address, family })),
      );
      return;
    }
    callback(null, primaryAddress.address, primaryAddress.family);
  };

const AUTO_SELECT_FAMILY_OPTIONS = {
  autoSelectFamily: true,
} as const satisfies Pick<TcpSocketConnectOpts, "autoSelectFamily">;

export const fetchWithResolvedAddress = async ({
  addresses,
  body,
  headers,
  maxBytes,
  method = "GET",
  redirect = "error",
  signal,
  timeoutMs,
  url,
}: {
  addresses: readonly SafeOutboundAddress[];
  body?: SafeOutboundFetchBody | undefined;
  headers?: SafeOutboundHeaders | undefined;
  maxBytes: number;
  method?: string | undefined;
  redirect?: SafeOutboundRedirectMode | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  url: URL;
}): Promise<Result<SafeOutboundFetchResponse, SafeOutboundFetchError>> => {
  const primaryAddress = addresses.at(0);
  if (!primaryAddress) {
    return Result.err(
      new SafeOutboundFetchError({ message: "No resolved address available" }),
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Result.err(
      new SafeOutboundFetchError({
        message: "Only HTTP and HTTPS URLs can be fetched",
      }),
    );
  }

  return await Result.tryPromise({
    try: async () =>
      await new Promise<SafeOutboundFetchResponse>((resolve, reject) => {
        const requestHeaders = new Headers(headers);
        const bodyBytes = bodyToBytes(body);
        let guards: RequestGuards | null = null;
        if (bodyBytes && !requestHeaders.has("Content-Length")) {
          requestHeaders.set("Content-Length", String(bodyBytes.byteLength));
        }

        const request = (
          url.protocol === "https:" ? requestHttps : requestHttp
        )(
          // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- this is the safe outbound boundary: the target was validated and its DNS answer pinned above
          {
            ...AUTO_SELECT_FAMILY_OPTIONS,
            headers: headersToObject(requestHeaders),
            hostname: url.hostname,
            lookup: createPinnedLookup({ addresses, primaryAddress }),
            method,
            path: `${url.pathname}${url.search}`,
            port: url.port || undefined,
            protocol: url.protocol,
            servername: url.hostname,
          },
          (response) => {
            const status = response.statusCode ?? 0;
            const responseHeaders = headersFromIncoming(response.headers);

            if (status >= 300 && status < 400 && redirect === "error") {
              response.resume();
              guards?.cleanup();
              reject(
                new SafeOutboundFetchError({
                  message: "Redirects are not allowed",
                }),
              );
              return;
            }

            const chunks: Uint8Array[] = [];
            let total = 0;
            response.on("data", (chunk: Uint8Array) => {
              total += chunk.byteLength;
              if (total > maxBytes) {
                response.destroy(
                  new SafeOutboundFetchError({
                    message: "Response body exceeded size limit",
                  }),
                );
                return;
              }
              chunks.push(chunk);
            });
            response.on("error", (cause) => {
              guards?.cleanup();
              reject(cause);
            });
            response.on("end", () => {
              guards?.cleanup();
              resolve({
                body: concatChunks(chunks, total),
                headers: responseHeaders,
                ok: status >= 200 && status < 300,
                status,
              });
            });
          },
        );
        guards = attachRequestGuards({ reject, request, signal, timeoutMs });
        if (guards === null) {
          return;
        }

        if (bodyBytes) {
          request.write(bodyBytes);
        }
        request.end();
      }),
    catch: (cause) =>
      SafeOutboundFetchError.is(cause)
        ? cause
        : new SafeOutboundFetchError({
            message: "Outbound request failed",
            cause,
          }),
  });
};

export const fetchStreamWithResolvedAddress = async ({
  addresses,
  body,
  headers,
  maxBytes,
  method = "GET",
  redirect = "error",
  signal,
  timeoutMs,
  url,
}: {
  addresses: readonly SafeOutboundAddress[];
  body?: SafeOutboundFetchBody | undefined;
  headers?: SafeOutboundHeaders | undefined;
  maxBytes: number;
  method?: string | undefined;
  redirect?: SafeOutboundRedirectMode | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  url: URL;
}): Promise<
  Result<SafeOutboundFetchStreamResponse, SafeOutboundFetchError>
> => {
  const primaryAddress = addresses.at(0);
  if (!primaryAddress) {
    return Result.err(
      new SafeOutboundFetchError({ message: "No resolved address available" }),
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Result.err(
      new SafeOutboundFetchError({
        message: "Only HTTP and HTTPS URLs can be fetched",
      }),
    );
  }

  return await Result.tryPromise({
    try: async () =>
      await new Promise<SafeOutboundFetchStreamResponse>((resolve, reject) => {
        const requestHeaders = new Headers(headers);
        const bodyBytes = bodyToBytes(body);
        let guards: RequestGuards | null = null;
        if (bodyBytes && !requestHeaders.has("Content-Length")) {
          requestHeaders.set("Content-Length", String(bodyBytes.byteLength));
        }

        const request = (
          url.protocol === "https:" ? requestHttps : requestHttp
        )(
          // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- this is the safe outbound boundary: the target was validated and its DNS answer pinned above
          {
            ...AUTO_SELECT_FAMILY_OPTIONS,
            headers: headersToObject(requestHeaders),
            hostname: url.hostname,
            lookup: createPinnedLookup({ addresses, primaryAddress }),
            method,
            path: `${url.pathname}${url.search}`,
            port: url.port || undefined,
            protocol: url.protocol,
            servername: url.hostname,
          },
          (response) => {
            guards?.clearHeaderTimeout();
            const status = response.statusCode ?? 0;
            const responseHeaders = headersFromIncoming(response.headers);

            if (status >= 300 && status < 400 && redirect === "error") {
              response.resume();
              reject(
                new SafeOutboundFetchError({
                  message: "Redirects are not allowed",
                }),
              );
              return;
            }

            resolve({
              body: responseBodyToReadableStream({
                maxBytes,
                request,
                response,
              }),
              headers: responseHeaders,
              ok: status >= 200 && status < 300,
              status,
            });
          },
        );
        guards = attachRequestGuards({ reject, request, signal, timeoutMs });
        if (guards === null) {
          return;
        }

        if (bodyBytes) {
          request.write(bodyBytes);
        }
        request.end();
      }),
    catch: (cause) =>
      SafeOutboundFetchError.is(cause)
        ? cause
        : new SafeOutboundFetchError({
            message: "Outbound request failed",
            cause,
          }),
  });
};

const bodyToBytes = (
  body: SafeOutboundFetchBody | undefined,
): Uint8Array | null => {
  if (body === undefined) {
    return null;
  }

  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }

  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString());
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }

  return body;
};

const headersToObject = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
};

const headersFromIncoming = (
  headers: Record<string, string | string[] | undefined>,
): Headers => {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
      continue;
    }
    result.set(key, value);
  }
  return result;
};

const concatChunks = (
  chunks: readonly Uint8Array[],
  totalLength: number,
): ArrayBuffer => {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
};

const responseBodyToReadableStream = ({
  maxBytes,
  request,
  response,
}: {
  maxBytes: number;
  request: ReturnType<typeof requestHttp>;
  response: IncomingMessage;
}): ReadableStream<Uint8Array> => {
  let total = 0;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      response.on("data", (chunk: Uint8Array) => {
        total += chunk.byteLength;
        if (total > maxBytes) {
          const error = new SafeOutboundFetchError({
            message: "Response body exceeded size limit",
          });
          response.destroy(error);
          controller.error(error);
          return;
        }

        controller.enqueue(chunk);
      });
      response.on("error", (cause) => {
        controller.error(cause);
      });
      response.on("end", () => {
        controller.close();
      });
    },
    cancel() {
      response.destroy();
      request.destroy();
    },
  });
};

const abortReasonToError = (reason: unknown): Error => {
  if (reason instanceof Error) {
    return reason;
  }

  return new SafeOutboundFetchError({
    message: "Request aborted",
    cause: reason,
  });
};

/**
 * Cheap synchronous URL shape check: HTTPS, no embedded credentials,
 * no hash fragment, no IP-literal hostnames in private, loopback,
 * link-local, multicast, or reserved ranges (IPv4 + IPv6), and no
 * reserved local hostnames (`localhost`, `*.local`, `*.internal`,
 * etc.). Does NOT resolve DNS — `validateOutboundFetchTarget` is the
 * full check that should gate any actual outbound request.
 */
export const parseSafeOutboundUrl = (
  rawUrl: string,
): Result<URL, SafeOutboundFetchError> =>
  parseOutboundUrl(rawUrl, OUTBOUND_PROTOCOL_POLICY.HTTPS_ONLY);

export const OUTBOUND_PROTOCOL_POLICY = {
  HTTP_AND_HTTPS: "http-and-https",
  HTTPS_ONLY: "https-only",
} as const;

type OutboundProtocolPolicy =
  (typeof OUTBOUND_PROTOCOL_POLICY)[keyof typeof OUTBOUND_PROTOCOL_POLICY];

const parseOutboundUrl = (
  rawUrl: string,
  protocolPolicy: OutboundProtocolPolicy,
): Result<URL, SafeOutboundFetchError> => {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_OUTBOUND_URL_LENGTH) {
    return Result.err(
      new SafeOutboundFetchError({ message: "URL is invalid" }),
    );
  }

  const valid = v.safeParse(v.pipe(v.string(), v.url()), trimmed);
  if (!valid.success) {
    return Result.err(
      new SafeOutboundFetchError({ message: "URL is invalid" }),
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return Result.err(
      new SafeOutboundFetchError({ message: "URL is invalid" }),
    );
  }

  const isAllowedProtocol =
    url.protocol === "https:" ||
    (protocolPolicy === OUTBOUND_PROTOCOL_POLICY.HTTP_AND_HTTPS &&
      url.protocol === "http:");
  if (!isAllowedProtocol) {
    return Result.err(
      new SafeOutboundFetchError({
        message:
          protocolPolicy === OUTBOUND_PROTOCOL_POLICY.HTTPS_ONLY
            ? "URL must use HTTPS"
            : "URL must use HTTP or HTTPS",
      }),
    );
  }

  if (url.username !== "" || url.password !== "") {
    return Result.err(
      new SafeOutboundFetchError({
        message: "URL must not contain credentials",
      }),
    );
  }

  if (url.hash !== "") {
    return Result.err(
      new SafeOutboundFetchError({ message: "URL is not allowed" }),
    );
  }

  const rawHost = url.hostname.toLowerCase();
  if (rawHost === "") {
    return Result.err(
      new SafeOutboundFetchError({ message: "URL must include a hostname" }),
    );
  }

  // URL.hostname keeps brackets around IPv6 literals; strip them so
  // the IPv6 checks below see a bare address. For DNS names, also
  // strip a trailing dot (e.g. `localhost.`) which URL parsing
  // preserves but resolves identically to the bare name.
  const isIPv6Literal = rawHost.startsWith("[") && rawHost.endsWith("]");
  const host = isIPv6Literal ? rawHost.slice(1, -1) : trimTrailingDots(rawHost);

  if (BLOCKED_HOST_EXACT.has(host)) {
    return Result.err(
      new SafeOutboundFetchError({ message: "URL host is not allowed" }),
    );
  }

  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return Result.err(
        new SafeOutboundFetchError({ message: "URL host is not allowed" }),
      );
    }
  }

  if (isIPv6Literal || host.includes(":")) {
    if (isBlockedIPv6(host)) {
      return Result.err(
        new SafeOutboundFetchError({ message: "URL host is not allowed" }),
      );
    }
    return Result.ok(url);
  }

  const ipv4 = parseIPv4(host);
  if (ipv4 !== undefined && isBlockedIPv4(ipv4)) {
    return Result.err(
      new SafeOutboundFetchError({ message: "URL host is not allowed" }),
    );
  }

  return Result.ok(url);
};

export type OutboundFetchTarget = {
  addresses: SafeOutboundAddress[];
  url: URL;
};

type ResolveOutboundAddresses = (
  hostname: string,
) => Promise<Result<SafeOutboundAddress[], SafeOutboundFetchError>>;

/**
 * Full SSRF check: applies the selected protocol policy, then resolves DNS
 * and rejects targets whose resolved addresses fall in
 * any private, loopback, link-local, multicast, or reserved range.
 * The returned `addresses` are meant to be pinned into the actual
 * fetch (see `safeOutboundFetchBytes`) so DNS cannot be re-resolved
 * to an internal address between validation and the TCP connect.
 */
export const validateOutboundFetchTarget = async (
  rawUrl: string | URL,
  {
    protocolPolicy = OUTBOUND_PROTOCOL_POLICY.HTTPS_ONLY,
    resolveAddresses = resolveOutboundAddresses,
    signal,
    timeoutMs = 0,
  }: {
    protocolPolicy?: OutboundProtocolPolicy;
    resolveAddresses?: ResolveOutboundAddresses;
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
  } = {},
): Promise<Result<OutboundFetchTarget, SafeOutboundFetchError>> => {
  const parsed = parseOutboundUrl(rawUrl.toString(), protocolPolicy);
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }

  const resolution = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async () => await resolveAddresses(parsed.value.hostname),
        { label: "outbound DNS resolution", signal, timeoutMs },
      ),
    catch: (cause) => {
      if (TimeoutError.is(cause)) {
        return new SafeOutboundFetchError({
          message: "Request timed out",
          cause,
        });
      }
      if (SafeOutboundFetchError.is(cause)) {
        return cause;
      }
      return new SafeOutboundFetchError({
        message: "URL host could not be resolved",
        cause,
      });
    },
  });
  if (Result.isError(resolution)) {
    return Result.err(resolution.error);
  }
  const addresses = resolution.value;
  if (Result.isError(addresses)) {
    return Result.err(addresses.error);
  }

  if (
    addresses.value.length === 0 ||
    addresses.value.some(({ address }) => isPrivateResolvedAddress(address))
  ) {
    return Result.err(
      new SafeOutboundFetchError({ message: "URL host is not allowed" }),
    );
  }

  return Result.ok({ addresses: addresses.value, url: parsed.value });
};

export const safeOutboundFetchBytes = async ({
  body,
  headers,
  maxBytes,
  method,
  redirect,
  signal,
  timeoutMs,
  url,
}: {
  body?: SafeOutboundFetchBody | undefined;
  headers?: SafeOutboundHeaders | undefined;
  maxBytes: number;
  method?: string | undefined;
  redirect?: SafeOutboundRedirectMode | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  url: string | URL;
}): Promise<Result<SafeOutboundFetchResponse, SafeOutboundFetchError>> => {
  const startedAt = Temporal.Now.instant().epochMilliseconds;
  const target = await validateOutboundFetchTarget(url, { signal, timeoutMs });
  if (Result.isError(target)) {
    return Result.err(target.error);
  }
  const remainingTimeoutMs =
    timeoutMs - (Temporal.Now.instant().epochMilliseconds - startedAt);
  if (remainingTimeoutMs <= 0) {
    return Result.err(
      new SafeOutboundFetchError({ message: "Request timed out" }),
    );
  }

  return await fetchWithResolvedAddress({
    addresses: target.value.addresses,
    body,
    headers,
    maxBytes,
    method,
    redirect,
    signal,
    timeoutMs: remainingTimeoutMs,
    url: target.value.url,
  });
};

export const safeOutboundFetchStream = async ({
  body,
  headers,
  maxBytes,
  method,
  redirect,
  signal,
  timeoutMs,
  url,
}: {
  body?: SafeOutboundFetchBody | undefined;
  headers?: SafeOutboundHeaders | undefined;
  maxBytes: number;
  method?: string | undefined;
  redirect?: SafeOutboundRedirectMode | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  url: string | URL;
}): Promise<
  Result<SafeOutboundFetchStreamResponse, SafeOutboundFetchError>
> => {
  const startedAt = Temporal.Now.instant().epochMilliseconds;
  const target = await validateOutboundFetchTarget(url, { signal, timeoutMs });
  if (Result.isError(target)) {
    return Result.err(target.error);
  }
  const remainingTimeoutMs =
    timeoutMs - (Temporal.Now.instant().epochMilliseconds - startedAt);
  if (remainingTimeoutMs <= 0) {
    return Result.err(
      new SafeOutboundFetchError({ message: "Request timed out" }),
    );
  }

  return await fetchStreamWithResolvedAddress({
    addresses: target.value.addresses,
    body,
    headers,
    maxBytes,
    method,
    redirect,
    signal,
    timeoutMs: remainingTimeoutMs,
    url: target.value.url,
  });
};

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".private",
  ".corp",
  ".home",
  ".lan",
];

const BLOCKED_HOST_EXACT = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
]);

const trimTrailingDots = (s: string): string => {
  let end = s.length;
  while (end > 0 && s[end - 1] === ".") {
    end -= 1;
  }
  return end === s.length ? s : s.slice(0, end);
};

type IPv4 = readonly [number, number, number, number];

const parseOctet = (s: string): number | undefined => {
  if (s === "" || !/^\d+$/u.test(s)) {
    return undefined;
  }
  const n = Number(s);
  if (n < 0 || n > 255) {
    return undefined;
  }
  return n;
};

const parseIPv4 = (host: string): IPv4 | undefined => {
  const [s0, s1, s2, s3, ...rest] = host.split(".");
  if (
    rest.length > 0 ||
    s0 === undefined ||
    s1 === undefined ||
    s2 === undefined ||
    s3 === undefined
  ) {
    return undefined;
  }
  const o0 = parseOctet(s0);
  const o1 = parseOctet(s1);
  const o2 = parseOctet(s2);
  const o3 = parseOctet(s3);
  if (
    o0 === undefined ||
    o1 === undefined ||
    o2 === undefined ||
    o3 === undefined
  ) {
    return undefined;
  }
  return [o0, o1, o2, o3];
};

const isBlockedIPv4 = (ip: IPv4): boolean => {
  const [a, b] = ip;
  if (a === 0) {
    return true;
  } // 0.0.0.0/8
  if (a === 10) {
    return true;
  } // 10.0.0.0/8
  if (a === 127) {
    return true;
  } // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) {
    return true;
  } // link-local incl. AWS metadata
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  } // 172.16.0.0/12
  if (a === 192 && b === 168) {
    return true;
  } // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  } // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && ip[2] === 0) {
    return true;
  } // 192.0.0.0/24
  if (a === 192 && b === 0 && ip[2] === 2) {
    return true;
  } // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  } // 198.18.0.0/15
  if (a === 198 && b === 51 && ip[2] === 100) {
    return true;
  } // TEST-NET-2
  if (a === 203 && b === 0 && ip[2] === 113) {
    return true;
  } // TEST-NET-3
  if (a >= 224 && a <= 239) {
    return true;
  } // 224.0.0.0/4 multicast
  if (a >= 240) {
    return true;
  } // 240.0.0.0/4 reserved + 255.255.255.255
  return false;
};

type IPv6 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const expandIPv6 = (host: string): IPv6 | undefined => {
  let hexadecimal = host;
  if (host.includes(".")) {
    const separator = host.lastIndexOf(":");
    const ipv4 = parseIPv4(host.slice(separator + 1));
    if (ipv4 === undefined) {
      return undefined;
    }
    const [a, b, c, d] = ipv4;
    hexadecimal = `${host.slice(0, separator + 1)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }

  const [left = "", right, ...extra] = hexadecimal.split("::");
  if (extra.length > 0) {
    return undefined;
  }
  const leading = left === "" ? [] : left.split(":");
  const trailing = right === undefined || right === "" ? [] : right.split(":");
  const missing = 8 - leading.length - trailing.length;
  if (right === undefined ? missing !== 0 : missing < 1) {
    return undefined;
  }
  const parts = [
    ...leading,
    ...Array.from({ length: missing }, () => "0"),
    ...trailing,
  ];
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))) {
    return undefined;
  }
  const [a, b, c, d, e, f, g, h] = parts.map((part) =>
    Number.parseInt(part, 16),
  );
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    e === undefined ||
    f === undefined ||
    g === undefined ||
    h === undefined
  ) {
    return undefined;
  }
  return [a, b, c, d, e, f, g, h];
};

const ipv4FromHextets = (high: number, low: number): IPv4 => [
  Math.trunc(high / 256),
  high % 256,
  Math.trunc(low / 256),
  low % 256,
];

const IPV6_POLICY_VERDICT = {
  allow: "allow",
  block: "block",
  ipv4Tail: "ipv4-tail",
  ipv4SixToFour: "ipv4-six-to-four",
  ipv4Teredo: "ipv4-teredo",
} as const;

type IPv6Policy = {
  prefix: bigint;
  length: number;
  verdict: (typeof IPV6_POLICY_VERDICT)[keyof typeof IPV6_POLICY_VERDICT];
};

// IANA IPv6 special-purpose registry, last updated 2025-10-09.
// Globally reachable entries are allowed; non-global and deprecated entries
// are blocked. Mapped, WKP NAT64, 6to4 and Teredo apply the IPv4 policy.
// RFC 4291 also excludes deprecated IPv4-compatible space and multicast.
// https://www.iana.org/assignments/iana-ipv6-special-registry/
export const OUTBOUND_IPV6_POLICY = [
  {
    prefix: 0x00_00_00_00_00_00_00_00_00_00_00_00_00_00_00_01n,
    length: 128,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0x00_00_00_00_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 128,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0x00_00_00_00_00_00_00_00_00_00_ff_ff_00_00_00_00n,
    length: 96,
    verdict: IPV6_POLICY_VERDICT.ipv4Tail,
  },
  {
    prefix: 0x00_64_ff_9b_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 96,
    verdict: IPV6_POLICY_VERDICT.ipv4Tail,
  },
  {
    prefix: 0x00_64_ff_9b_00_01_00_00_00_00_00_00_00_00_00_00n,
    length: 48,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0x01_00_00_00_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 64,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0x01_00_00_00_00_00_00_01_00_00_00_00_00_00_00_00n,
    length: 64,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0x20_01_00_00_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 23,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0x20_01_00_00_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 32,
    verdict: IPV6_POLICY_VERDICT.ipv4Teredo,
  },
  {
    prefix: 0x20_01_00_01_00_00_00_00_00_00_00_00_00_00_00_01n,
    length: 128,
    verdict: IPV6_POLICY_VERDICT.allow,
  },
  {
    prefix: 0x20_01_00_01_00_00_00_00_00_00_00_00_00_00_00_02n,
    length: 128,
    verdict: IPV6_POLICY_VERDICT.allow,
  },
  {
    prefix: 0x20_01_00_01_00_00_00_00_00_00_00_00_00_00_00_03n,
    length: 128,
    verdict: IPV6_POLICY_VERDICT.allow,
  },
  {
    prefix: 0x20_01_00_02_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 48,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0x20_01_00_03_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 32,
    verdict: IPV6_POLICY_VERDICT.allow,
  },
  {
    prefix: 0x20_01_00_04_01_12_00_00_00_00_00_00_00_00_00_00n,
    length: 48,
    verdict: IPV6_POLICY_VERDICT.allow,
  },
  {
    prefix: 0x20_01_00_10_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 28,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0x20_01_00_20_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 28,
    verdict: IPV6_POLICY_VERDICT.allow,
  },
  {
    prefix: 0x20_01_00_30_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 28,
    verdict: IPV6_POLICY_VERDICT.allow,
  },
  {
    prefix: 0x20_01_0d_b8_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 32,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0x20_02_00_00_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 16,
    verdict: IPV6_POLICY_VERDICT.ipv4SixToFour,
  },
  {
    prefix: 0x26_20_00_4f_80_00_00_00_00_00_00_00_00_00_00_00n,
    length: 48,
    verdict: IPV6_POLICY_VERDICT.allow,
  },
  {
    prefix: 0x3f_ff_00_00_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 20,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0x5f_00_00_00_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 16,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0xfc_00_00_00_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 7,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0xfe_80_00_00_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 10,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0x00_00_00_00_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 96,
    verdict: IPV6_POLICY_VERDICT.block,
  },
  {
    prefix: 0xff_00_00_00_00_00_00_00_00_00_00_00_00_00_00_00n,
    length: 8,
    verdict: IPV6_POLICY_VERDICT.block,
  },
] as const satisfies readonly IPv6Policy[];

const IPV6_POLICY_BY_SPECIFICITY = OUTBOUND_IPV6_POLICY.toSorted(
  (left, right) => right.length - left.length,
);

const isBlockedIPv6 = (host: string): boolean => {
  const expanded = expandIPv6(host);
  if (expanded === undefined) {
    return true;
  }
  const address = expanded.reduce(
    (value, part) => value * 65_536n + BigInt(part),
    0n,
  );
  const policy = IPV6_POLICY_BY_SPECIFICITY.find(({ prefix, length }) => {
    const hostBits = 2n ** BigInt(128 - length);
    return address / hostBits === prefix / hostBits;
  });
  if (policy === undefined) {
    return false;
  }

  const tailHigh = expanded[6];
  const tailLow = expanded[7];
  const { verdict } = policy;
  switch (verdict) {
    case IPV6_POLICY_VERDICT.allow:
      return false;
    case IPV6_POLICY_VERDICT.block:
      return true;
    case IPV6_POLICY_VERDICT.ipv4Tail:
      return isBlockedIPv4(ipv4FromHextets(tailHigh, tailLow));
    case IPV6_POLICY_VERDICT.ipv4SixToFour:
      return isBlockedIPv4(ipv4FromHextets(expanded[1], expanded[2]));
    case IPV6_POLICY_VERDICT.ipv4Teredo:
      return isBlockedIPv4(
        ipv4FromHextets(0xff_ff - tailHigh, 0xff_ff - tailLow),
      );
    default:
      verdict satisfies never;
      return panic(`Unhandled IPv6 policy verdict: ${String(verdict)}`);
  }
};

const resolveOutboundAddresses = async (
  hostname: string,
): Promise<Result<SafeOutboundAddress[], SafeOutboundFetchError>> => {
  const normalizedHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  const literalFamily = isIP(normalizedHost);
  if (literalFamily !== 0) {
    return Result.ok([
      {
        address: normalizedHost,
        family: literalFamily === 6 ? 6 : 4,
      },
    ]);
  }

  const addresses = await Result.tryPromise({
    try: async () => await lookup(normalizedHost, { all: true }),
    catch: (cause) =>
      new SafeOutboundFetchError({
        message: "URL host could not be resolved",
        cause,
      }),
  });

  if (Result.isError(addresses)) {
    return Result.err(addresses.error);
  }

  return Result.ok(
    addresses.value.map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4,
    })),
  );
};

const isPrivateResolvedAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 6) {
    return isBlockedIPv6(address);
  }

  const ipv4 = parseIPv4(address);
  if (ipv4 === undefined) {
    return true;
  }

  return isBlockedIPv4(ipv4);
};
