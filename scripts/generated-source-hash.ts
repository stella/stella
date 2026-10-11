import { sha256Hex } from "@stll/sha256/node";

export const hashGeneratedSource = (contents: string | Uint8Array) =>
  sha256Hex(contents);
