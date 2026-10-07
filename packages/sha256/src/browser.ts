const inputBytes = (input: string | Uint8Array | ArrayBuffer) => {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  return input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : Uint8Array.from(input);
};

export const sha256Bytes = async (
  input: string | Uint8Array | ArrayBuffer,
): Promise<ArrayBuffer> =>
  await crypto.subtle.digest("SHA-256", inputBytes(input));

export const sha256Hex = async (
  input: string | Uint8Array | ArrayBuffer,
): Promise<string> => {
  const digest = await sha256Bytes(input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};
