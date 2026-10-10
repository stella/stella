import { sha256Hex } from "@stll/sha256/bun";

export const templatePackContentIdentity = (bytes: Uint8Array) => ({
  sha256: sha256Hex(bytes),
});
