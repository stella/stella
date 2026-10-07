import { createHash } from "node:crypto";

type Sha256Input = string | Uint8Array;

export const sha256Hex = (input: Sha256Input): string =>
  createHash("sha256").update(input).digest("hex");

export const sha256Base64Url = (input: Sha256Input): string =>
  createHash("sha256").update(input).digest("base64url");
