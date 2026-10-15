import type { Buffer } from "node:buffer";

export type Sha256Input = string | Uint8Array;

/** Incremental SHA-256 retains update order and explicit UTF-8 encoding. */
export type Sha256Hasher = {
  update: (input: Sha256Input, encoding?: "utf-8") => Sha256Hasher;
  digest: {
    (): Buffer;
    (encoding: "hex" | "base64" | "base64url"): string;
  };
};
