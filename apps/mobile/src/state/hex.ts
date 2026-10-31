/** Bytes as lowercase hex, two digits a byte: the form digests travel in. */
export const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
