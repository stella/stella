/**
 * How a document's bytes cross from the app into the viewer's web view: in
 * slices of base64, each one bridge message. A slice is a multiple of three
 * bytes, so each encodes to whole base64 groups and decodes on its own.
 */
export const CHUNK_BYTES = 3 * 256 * 1024;

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
