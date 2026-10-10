import { sha256Hex } from "@stll/sha256/bun";

/** Digest downloaded or published artifact bytes before compression or encoding. */
export const hashArtifactBytes = (bytes: ArrayBuffer | Uint8Array | string) =>
  sha256Hex(
    typeof bytes === "string" || bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes),
  );
