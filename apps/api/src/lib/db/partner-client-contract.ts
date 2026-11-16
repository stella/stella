import { randomBytes } from "node:crypto";

import { sha256Base64Url } from "@stll/sha256/bun";

/**
 * `oauth_client.type` of a partner client: a hosted assistant that cannot
 * register itself (no dynamic registration), so an operator registers one
 * confidential client for it. Its users sign in and consent like any other
 * client's. Loads no auth runtime or server configuration.
 */
export const PARTNER_CLIENT_TYPE = "partner";

/**
 * The SHA-256 digest (base64url, unpadded) of a partner client secret: what
 * the server stores and the only form of the secret it ever receives.
 */
export const PARTNER_CLIENT_SECRET_SHA256_PATTERN = /^[\w-]{43}$/u;

/**
 * A new client secret and its digest, made on the operator's machine. 48
 * bytes make a 64-character secret, so a secret pasted where its digest
 * belongs fails the digest pattern instead of reaching a server-side run.
 */
export const mintPartnerClientSecret = () => {
  const clientSecret = randomBytes(48).toString("base64url");
  return { clientSecret, clientSecretSha256: sha256Base64Url(clientSecret) };
};
