type BrowserSha256Input = string | Uint8Array | ArrayBuffer | Blob;

// A Blob (such as a selected File) is read here, so callers never hold a
// separate body read next to their network transfers.
const inputBytes = async (input: BrowserSha256Input) => {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  if (input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  return input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : Uint8Array.from(input);
};

export const sha256Bytes = async (
  input: BrowserSha256Input,
): Promise<ArrayBuffer> =>
  await crypto.subtle.digest("SHA-256", await inputBytes(input));

export const sha256Hex = async (input: BrowserSha256Input): Promise<string> => {
  const digest = await sha256Bytes(input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};
