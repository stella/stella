import { Result, TaggedError } from "better-result";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";

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

export const fetchWithResolvedAddress = async ({
  addresses,
  body,
  headers,
  maxBytes,
  method = "GET",
  timeoutMs,
  url,
}: {
  addresses: readonly SafeOutboundAddress[];
  body?: SafeOutboundFetchBody | undefined;
  headers?: SafeOutboundHeaders | undefined;
  maxBytes: number;
  method?: string | undefined;
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
              if (typeof options === "object" && options?.all === true) {
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

            if (status >= 300 && status < 400) {
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
