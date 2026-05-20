import { Result, TaggedError } from "better-result";
import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import * as v from "valibot";

export class SafeOutboundFetchError extends TaggedError(
  "SafeOutboundFetchError",
)<{
  cause?: unknown;
  message: string;
}>() {}

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

type SafeOutboundRedirectMode = "error" | "manual";

export const fetchWithResolvedAddress = async ({
  addresses,
  body,
  headers,
  maxBytes,
  method = "GET",
  redirect = "error",
  timeoutMs,
  url,
}: {
  addresses: readonly SafeOutboundAddress[];
  body?: SafeOutboundFetchBody | undefined;
  headers?: SafeOutboundHeaders | undefined;
  maxBytes: number;
  method?: string | undefined;
  redirect?: SafeOutboundRedirectMode | undefined;
  timeoutMs: number;
  url: URL;
}): Promise<Result<SafeOutboundFetchResponse, SafeOutboundFetchError>> => {
  const address = addresses.at(0);
  if (!address) {
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
        if (bodyBytes && !requestHeaders.has("Content-Length")) {
          requestHeaders.set("Content-Length", String(bodyBytes.byteLength));
        }

        const request = (
          url.protocol === "https:" ? requestHttps : requestHttp
        )(
          {
            headers: headersToObject(requestHeaders),
            hostname: url.hostname,
            lookup: (_hostname, options, callback) => {
              if (typeof options === "object" && options.all === true) {
                callback(null, [address]);
                return;
              }
              callback(null, address.address, address.family);
            },
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
              clearTimeout(timeout);
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
              clearTimeout(timeout);
              reject(cause);
            });
            response.on("end", () => {
              clearTimeout(timeout);
              resolve({
                body: concatChunks(chunks, total),
                headers: responseHeaders,
                ok: status >= 200 && status < 300,
                status,
              });
            });
          },
        );
        const timeout = setTimeout(() => {
          request.destroy(
            new SafeOutboundFetchError({ message: "Request timed out" }),
          );
        }, timeoutMs);

        request.on("error", (cause) => {
          clearTimeout(timeout);
          reject(cause);
        });

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
  signal,
  timeoutMs,
  url,
}: {
  addresses: readonly SafeOutboundAddress[];
  body?: SafeOutboundFetchBody | undefined;
  headers?: SafeOutboundHeaders | undefined;
  maxBytes: number;
  method?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  url: URL;
}): Promise<
  Result<SafeOutboundFetchStreamResponse, SafeOutboundFetchError>
> => {
  const address = addresses.at(0);
  if (!address) {
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
        if (bodyBytes && !requestHeaders.has("Content-Length")) {
          requestHeaders.set("Content-Length", String(bodyBytes.byteLength));
        }

        const request = (
          url.protocol === "https:" ? requestHttps : requestHttp
        )(
          {
            headers: headersToObject(requestHeaders),
            hostname: url.hostname,
            lookup: (_hostname, options, callback) => {
              if (typeof options === "object" && options.all === true) {
                callback(null, [address]);
                return;
              }
              callback(null, address.address, address.family);
            },
            method,
            path: `${url.pathname}${url.search}`,
            port: url.port || undefined,
            protocol: url.protocol,
            servername: url.hostname,
          },
          (response) => {
            clearTimeout(timeout);
            const status = response.statusCode ?? 0;
            const responseHeaders = headersFromIncoming(response.headers);

            if (status >= 300 && status < 400) {
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
        const timeout = setTimeout(() => {
          request.destroy(
            new SafeOutboundFetchError({ message: "Request timed out" }),
          );
        }, timeoutMs);

        const abort = () => {
          request.destroy(abortReasonToError(signal?.reason));
        };
        if (signal?.aborted) {
          const error = abortReasonToError(signal.reason);
          clearTimeout(timeout);
          request.destroy(error);
          reject(error);
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });

        request.on("error", (cause) => {
          signal?.removeEventListener("abort", abort);
          clearTimeout(timeout);
          reject(cause);
        });

        request.on("close", () => {
          signal?.removeEventListener("abort", abort);
          clearTimeout(timeout);
        });

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

  if (url.protocol !== "https:") {
    return Result.err(
      new SafeOutboundFetchError({ message: "URL must use HTTPS" }),
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

/**
 * Full SSRF check: parses the URL with `parseSafeOutboundUrl`, then
 * resolves DNS and rejects targets whose resolved addresses fall in
 * any private, loopback, link-local, multicast, or reserved range.
 * The returned `addresses` are meant to be pinned into the actual
 * fetch (see `safeOutboundFetchBytes`) so DNS cannot be re-resolved
 * to an internal address between validation and the TCP connect.
 */
export const validateOutboundFetchTarget = async (
  rawUrl: string | URL,
): Promise<Result<OutboundFetchTarget, SafeOutboundFetchError>> => {
  const parsed = parseSafeOutboundUrl(rawUrl.toString());
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }

  const addresses = await resolvePublicAddresses(parsed.value.hostname);
  if (Result.isError(addresses)) {
    return Result.err(addresses.error);
  }

  return Result.ok({ addresses: addresses.value, url: parsed.value });
};

export const safeOutboundFetchBytes = async ({
  body,
  headers,
  maxBytes,
  method,
  redirect,
  timeoutMs,
  url,
}: {
  body?: SafeOutboundFetchBody | undefined;
  headers?: SafeOutboundHeaders | undefined;
  maxBytes: number;
  method?: string | undefined;
  redirect?: SafeOutboundRedirectMode | undefined;
  timeoutMs: number;
  url: string | URL;
}): Promise<Result<SafeOutboundFetchResponse, SafeOutboundFetchError>> => {
  const target = await validateOutboundFetchTarget(url);
  if (Result.isError(target)) {
    return Result.err(target.error);
  }

  return await fetchWithResolvedAddress({
    addresses: target.value.addresses,
    body,
    headers,
    maxBytes,
    method,
    redirect,
    timeoutMs,
    url: target.value.url,
  });
};

export const safeOutboundFetchStream = async ({
  body,
  headers,
  maxBytes,
  method,
  signal,
  timeoutMs,
  url,
}: {
  body?: SafeOutboundFetchBody | undefined;
  headers?: SafeOutboundHeaders | undefined;
  maxBytes: number;
  method?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  url: string | URL;
}): Promise<
  Result<SafeOutboundFetchStreamResponse, SafeOutboundFetchError>
> => {
  const target = await validateOutboundFetchTarget(url);
  if (Result.isError(target)) {
    return Result.err(target.error);
  }

  return await fetchStreamWithResolvedAddress({
    addresses: target.value.addresses,
    body,
    headers,
    maxBytes,
    method,
    signal,
    timeoutMs,
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
  if (s === "" || !/^\d+$/.test(s)) {
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

const isBlockedIPv6 = (host: string): boolean => {
  const compressed = host.toLowerCase();

  if (compressed === "::" || compressed === "::1") {
    return true;
  }

  // The first hextet of fe80::/10, fc00::/7, and ff00::/8 is always
  // ≥ 0x1000, so URL normalization keeps all four hex digits — no
  // leading-zero forms like `fe8::` to worry about, and matching
  // shorter prefixes here would over-block legitimate addresses.

  if (/^fe[89ab][0-9a-f]:/.test(compressed)) {
    return true;
  }

  if (/^f[cd][0-9a-f]{2}:/.test(compressed)) {
    return true;
  }

  if (/^ff[0-9a-f]{2}:/.test(compressed)) {
    return true;
  }

  if (
    compressed.startsWith("2001:db8:") ||
    compressed.startsWith("2001:2:") ||
    compressed.startsWith("100:")
  ) {
    return true;
  }

  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(compressed);
  const dottedIp = dotted?.[1];
  if (dottedIp !== undefined) {
    const ipv4 = parseIPv4(dottedIp);
    if (ipv4 && isBlockedIPv4(ipv4)) {
      return true;
    }
  }

  // The URL parser normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1.
  // Decode the trailing two hextets back to four IPv4 octets.
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(compressed);
  const hexHigh = hex?.[1];
  const hexLow = hex?.[2];
  if (hexHigh !== undefined && hexLow !== undefined) {
    const high = Number.parseInt(hexHigh, 16);
    const low = Number.parseInt(hexLow, 16);
    const ipv4: IPv4 = [
      Math.trunc(high / 256),
      high % 256,
      Math.trunc(low / 256),
      low % 256,
    ];
    if (isBlockedIPv4(ipv4)) {
      return true;
    }
  }

  return false;
};

const resolvePublicAddresses = async (
  hostname: string,
): Promise<Result<SafeOutboundAddress[], SafeOutboundFetchError>> => {
  const normalizedHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  const literalFamily = isIP(normalizedHost);
  if (literalFamily !== 0) {
    return isPrivateResolvedAddress(normalizedHost)
      ? Result.err(
          new SafeOutboundFetchError({ message: "URL host is not allowed" }),
        )
      : Result.ok([
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

  if (
    addresses.value.length === 0 ||
    addresses.value.some(({ address }) => isPrivateResolvedAddress(address))
  ) {
    return Result.err(
      new SafeOutboundFetchError({ message: "URL host is not allowed" }),
    );
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
