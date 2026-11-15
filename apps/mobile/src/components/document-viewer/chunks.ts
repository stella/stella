/**
 * How a document's bytes cross between the app and the viewer's web view,
 * both ways: in slices of base64, each one bridge message. A slice is a multiple of three
 * bytes, so each encodes to whole base64 groups and decodes on its own.
 */
const CHUNK_BYTES = 3 * 256 * 1024;

/** The slices a file of `size` bytes is read in: `[offset, length]` each. */
export const chunksOf = (
  size: number,
  chunkBytes = CHUNK_BYTES,
): (readonly [offset: number, length: number])[] => {
  const chunks: (readonly [number, number])[] = [];
  for (let offset = 0; offset < size; offset += chunkBytes) {
    chunks.push([offset, Math.min(chunkBytes, size - offset)]);
  }
  return chunks;
};

/** Decodes one slice into `target` at `offset`; the bytes it wrote. */
export const decodeChunkInto = (
  base64: string,
  target: Uint8Array,
  offset: number,
): number => {
  const binary = atob(base64);
  for (let index = 0; index < binary.length; index += 1) {
    target[offset + index] = binary.codePointAt(index) ?? 0;
  }
  return binary.length;
};

/**
 * Encodes one slice as base64, as `decodeChunkInto` reads it. The bytes go
 * to `btoa` a few thousand at a time, so no call takes a whole slice as
 * arguments.
 */
export const encodeChunk = (bytes: Uint8Array): string => {
  const step = 8192;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
};
