/**
 * Zstandard compression for corpus payloads in object storage.
 * Bun-native (this is a Bun runtime; no JS fallback).
 */

export const zstdCompress = (data: string | Uint8Array): Uint8Array => {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return Bun.zstdCompressSync(bytes);
};

export const zstdDecompressToString = (data: Uint8Array): string =>
  Buffer.from(Bun.zstdDecompressSync(data)).toString("utf-8");
