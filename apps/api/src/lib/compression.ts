import { TaggedError } from "better-result";

/**
 * Zstandard compression for corpus payloads in object storage.
 * Bun-native (this is a Bun runtime; no JS fallback).
 *
 * The corpus read/write paths use the async variants: they run on Bun's
 * thread pool, so a pathological payload costs wall-clock but never blocks
 * the event loop — the ingestion daemon's heartbeats, watchdog, and sibling
 * loops keep running. The sync variants remain for one-shot scripts where
 * event-loop latency is irrelevant.
 */

/** A corpus payload exceeded the decompressed-size ceiling. */
export class PayloadBudgetError extends TaggedError("PayloadBudgetError")<{
  message: string;
}>() {}

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

/**
 * Decompress off-thread and enforce a decompressed-size ceiling, so a
 * corrupt or hostile object cannot hand a multi-gigabyte string to the
 * JSON parser or chunker downstream. The ceiling is checked after
 * decompression: zstd's frame header size hint is optional, so the byte
 * count is only trustworthy once the frame is actually decoded.
 */
export const zstdDecompressToStringBounded = async (
  data: Uint8Array,
  maxBytes: number,
): Promise<string> => {
  const out = await Bun.zstdDecompress(data);
  if (out.byteLength > maxBytes) {
    throw new PayloadBudgetError({
      message: `Decompressed payload is ${out.byteLength} bytes; ceiling is ${maxBytes}`,
    });
  }
  return Buffer.from(out).toString("utf-8");
};
