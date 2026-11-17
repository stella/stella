import { iterateBodyWithIdleDeadline } from "@stll/fetch/body-reader";

import { detached } from "@/api/lib/analytics/capture";

const DECODE_CHUNK_BYTES = 1024;

type ReadResponseTextPrefixOptions = {
  maxChars: number;
  idleMs: number;
  signal: AbortSignal;
};

/** Read the same UTF-16 prefix as Response.text().slice, without its tail. */
export const readResponseTextPrefix = async (
  response: Response,
  { maxChars, idleMs, signal }: ReadResponseTextPrefixOptions,
): Promise<{ content: string; truncated: boolean }> => {
  const decoder = new TextDecoder();
  let prefix = "";
  for await (const chunk of iterateBodyWithIdleDeadline(response, {
    idleMs,
    signal,
  })) {
    // A transport chunk can be arbitrarily large; only decode small pieces.
    for (
      let offset = 0;
      offset < chunk.byteLength;
      offset += DECODE_CHUNK_BYTES
    ) {
      const decoded = decoder.decode(
        chunk.subarray(offset, offset + DECODE_CHUNK_BYTES),
        { stream: true },
      );
      prefix = (prefix + decoded).slice(0, maxChars + 1);
      if (prefix.length > maxChars) {
        return { content: prefix.slice(0, maxChars), truncated: true };
      }
    }
  }
  const content = prefix + decoder.decode();
  return {
    content: content.slice(0, maxChars),
    truncated: content.length > maxChars,
  };
};

/** Cleanup cannot replace the HTTP status that decides a provider outcome. */
export const discardResponseBody = (response: Response): void => {
  detached(async () => {
    await Promise.allSettled([response.body?.cancel()]);
  }, "web-search.discard-response-body");
};
