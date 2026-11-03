import { sha256Bytes } from "@stll/sha256/bun";

import type { AuthorizationCrypto } from "../pkce";

/** Bun's crypto in the shape the app gets from expo-crypto. */
export const webCrypto: AuthorizationCrypto = {
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  sha256: async (input) =>
    await Promise.resolve(new Uint8Array(sha256Bytes(input))),
};
