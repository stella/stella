import { TaggedError } from "better-result";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";

/**
 * Zstandard compression for corpus payloads in object storage.
 * Bun-native (this is a Bun runtime; no JS fallback).
 *
 * The corpus read/write paths use the async variants: they run on Bun's
 * thread pool, so a pathological payload costs wall-clock but never blocks
 * the event loop. The sync variants remain for one-shot scripts where
 * event-loop latency is irrelevant.
 */

/** A corpus payload exceeded a size ceiling (transfer or decompressed). */
export class PayloadBudgetError extends TaggedError("PayloadBudgetError")<{
  message: string;
}> {}

/**
 * Upper bound on the size of a zstd frame that decodes to `inputBytes`
 * bytes: a frame can exceed its input by frame and block overhead, so a
 * ceiling on the transferred frame must sit above the ceiling on its
 * decoded output. Follows `ZSTD_COMPRESSBOUND`, which adds one part in 256
 * plus a margin that peaks at 64 bytes; the margin is applied at every size
 * so the bound is monotonic and never below zstd's own.
 */
export const zstdCompressBound = (inputBytes: number): number =>
  inputBytes + Math.ceil(inputBytes / 256) + 64;

export const zstdCompress = (data: string | Uint8Array): Uint8Array => {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return Bun.zstdCompressSync(bytes);
};

export const zstdDecompressToString = (data: Uint8Array): string =>
  Buffer.from(Bun.zstdDecompressSync(data)).toString("utf-8");

export const zstdCompressAsync = async (
  data: string | Uint8Array,
): Promise<Uint8Array> => {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return await Bun.zstdCompress(bytes);
};

const zstdDecompressBounded = promisify(zstdDecompress);

/**
 * Decompress off-thread and enforce a decompressed-size ceiling, so a
 * corrupt or hostile object cannot hand a multi-gigabyte string to the
 * JSON parser or chunker downstream. `node:zlib`'s `maxOutputLength`
 * enforces the ceiling during decoding — the oversized output is never
 * materialized, so a decompression bomb cannot exhaust the heap before
 * a post-hoc check would run.
 */
export const zstdDecompressToStringBounded = async (
  data: Uint8Array,
  maxBytes: number,
): Promise<string> => {
  try {
    const out = await zstdDecompressBounded(data, {
      maxOutputLength: maxBytes,
    });
    return out.toString("utf-8");
  } catch (error) {
    if (
      error instanceof RangeError ||
      (error instanceof Error &&
        "code" in error &&
        error.code === "ERR_BUFFER_TOO_LARGE")
    ) {
      throw new PayloadBudgetError({
        message: `Decompressed payload exceeds the ${maxBytes}-byte ceiling`,
      });
    }
    throw error;
  }
};
