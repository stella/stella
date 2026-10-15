import type { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { Sha256Hasher, Sha256Input } from "./types.ts";

export const createSha256 = (): Sha256Hasher => createHash("sha256");

export const sha256Hex = (input: Sha256Input): string =>
  createSha256().update(input).digest("hex");

export const sha256Base64 = (input: Sha256Input): string =>
  createSha256().update(input).digest("base64");

export const sha256Base64Url = (input: Sha256Input): string =>
  createSha256().update(input).digest("base64url");

export const sha256Bytes = (input: Sha256Input): Buffer =>
  createSha256().update(input).digest();
