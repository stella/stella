/** S3 represents SHA-256 checksums as base64; stored file hashes use hex. */
export const sha256HexToBase64 = (hex: string): string =>
  Buffer.from(hex, "hex").toString("base64");

export const sha256Base64ToHex = (base64: string): string =>
  Buffer.from(base64, "base64").toString("hex");
