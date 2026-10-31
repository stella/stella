// parser-output-unchanged: responses within the publisher byte ceiling stream through unchanged; a larger body fails the read as too-large.
import { TaggedError } from "better-result";
import { TransformStream } from "node:stream/web";

/** Maximum decoded bytes one publisher response may yield. */
export const PUBLISHER_BODY_MAX_BYTES = 64 * 1024 * 1024;

export class PublisherResponseTooLargeError extends TaggedError(
  "PublisherResponseTooLargeError",
)<{
  message: string;
  maxBytes: number;
}> {}

const copyResponse = (
  response: Response,
  body: ReadableStream<Uint8Array>,
): Response => {
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(wrapped, {
    redirected: { value: response.redirected },
    type: { value: response.type },
    url: { value: response.url },
  });
  return wrapped;
};

/**
 * Bound a publisher response before an adapter can choose how to consume it.
 * Fetch decodes content encodings before exposing the body, so this ceiling
 * also bounds a compressed HTTP response by the bytes its parser receives.
 */
export const limitPublisherResponse = (
  response: Response,
  maxBytes = PUBLISHER_BODY_MAX_BYTES,
): Response => {
  if (response.body === null) {
    return response;
  }
  let bytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          controller.error(
            new PublisherResponseTooLargeError({
              message: "Publisher response exceeded its byte limit",
              maxBytes,
            }),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return copyResponse(response, body);
};
