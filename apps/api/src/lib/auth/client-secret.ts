import { sha256Base64Url } from "@stll/sha256/bun";

/** Better Auth's default storeClientSecret: "hashed" encoding. */
export const hashOAuthClientSecret = (secret: string): string =>
  sha256Base64Url(secret);
