import { Result, TaggedError } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

/** A request body that is larger than the reader's byte bound. */
export class RequestBodyTooLargeError extends TaggedError(
  "RequestBodyTooLargeError",
)<{
  message: string;
  maximum: number;
}> {}

const requestBodyTooLarge = (maximum: number) =>
  new RequestBodyTooLargeError({
    message: "Request body exceeds the configured byte limit",
    maximum,
  });

/**
 * Whether an incoming request carries a body, asked without reading it. This
 * module owns every look at an incoming request's body stream; readers take
 * the bytes from {@link reframeBoundedRequest} or the request's own `text()`,
 * `json()` and `arrayBuffer()`.
 */
export const hasRequestBody = (request: Request): boolean =>
  request.body !== null;

/** A request whose body was read once and re-framed from its metered bytes. */
export type BoundedRequest = {
  readonly request: Request;
  /** The body's actual size in bytes; 0 without a body. */
  readonly bytes: number;
};

/**
 * The one reader that meters and re-frames a request body. A declared
 * Content-Length is checked first without touching the body; the actual bytes
 * are metered even when it is present, at most the allowed body is retained,
 * and the source is cancelled at the chunk that crosses the bound.
 *
 * The body is read once from the request itself, never through a tee: under
 * `Bun.serve({ routes })`, `clone()` of a request whose body has already
 * arrived leaves the original's stream locked, so a later stream reader of it
 * fails. The answer is a new request framed from exactly the metered bytes:
 * same url, method, signal and headers, with `content-length` set to the
 * metered size and `transfer-encoding` dropped. No reader needs the
 * socket-bound original: the pipeline resolves and seals the client address
 * once, before any body is read, and every resolver reads that sealed address
 * first. A request without a body is returned as is.
 */
export const reframeBoundedRequest = async (
  request: Request,
  maximum: number,
): Promise<Result<BoundedRequest, RequestBodyTooLargeError>> => {
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    parseIntegerToken(length, { sign: "unsigned", max: maximum }).isErr()
  ) {
    return Result.err(requestBodyTooLarge(maximum));
  }
  if (request.body === null) {
    return Result.ok({ request, bytes: 0 });
  }
  // Bun types the stream's chunks as `any`; a request body is bytes.
  const stream: ReadableStream<Uint8Array> = request.body;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > maximum) {
      // Leaving the loop cancels the source: the rest of the upload is never
      // read into this process.
      return Result.err(requestBodyTooLarge(maximum));
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.set("content-length", String(bytes));
  headers.delete("transfer-encoding");
  return Result.ok({
    request: new Request(request.url, {
      body,
      headers,
      method: request.method,
      signal: request.signal,
    }),
    bytes,
  });
};
