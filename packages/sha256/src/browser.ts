type BrowserSha256Input = string | Uint8Array | ArrayBuffer | Blob;

/**
 * Bytes of a Blob read and hashed per step. A selected File is never held
 * whole: memory stays at one chunk whatever the file size, and each
 * synchronous hash step covers at most this many bytes.
 */
export const BLOB_HASH_CHUNK_BYTES = 1024 * 1024;

const inputBytes = (input: Exclude<BrowserSha256Input, Blob>) => {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  return input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : Uint8Array.from(input);
};

// WebCrypto has no incremental digest, so a Blob is read once, front to back,
// in fixed slices fed to an incremental SHA-256. The hasher loads on the first
// Blob hash, outside the shell's eager bundle.
const blobDigest = async (blob: Blob): Promise<ArrayBuffer> => {
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const hasher = sha256.create();
  for (let offset = 0; offset < blob.size; offset += BLOB_HASH_CHUNK_BYTES) {
    const chunk = blob.slice(offset, offset + BLOB_HASH_CHUNK_BYTES);
    hasher.update(new Uint8Array(await chunk.arrayBuffer()));
  }
  return new Uint8Array(hasher.digest()).buffer;
};

export const sha256Bytes = async (
  input: BrowserSha256Input,
): Promise<ArrayBuffer> =>
  input instanceof Blob
    ? await blobDigest(input)
    : await crypto.subtle.digest("SHA-256", inputBytes(input));

export const sha256Hex = async (input: BrowserSha256Input): Promise<string> => {
  const digest = await sha256Bytes(input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};
