// Local (unverified) decode of the access token for `stella auth whoami`.
//
// The provider only mints a JWT-format access token when the CLI requests a
// `resource` at the token endpoint (see `constants.ts#getMcpResourceUrl`);
// its authenticity was already established by receiving it directly from the
// token endpoint over TLS, so `whoami` decodes locally rather than making a
// server round trip, per the design brief. There is no cheap endpoint to
// resolve `org_id` back to an org slug/name (`/oauth2/userinfo` only returns
// `sub`/`email`/`name`/`picture`), so `whoami` reports the id verbatim.

import { Result } from "better-result";
import * as v from "valibot";

// Hand-written rather than `v.InferOutput<typeof schema>` (see
// `cli-config.ts` for why: this package builds with `isolatedDeclarations`).
export type AccessTokenClaims = {
  readonly sub: string;
  readonly org_id?: string | undefined;
  readonly scope?: string | undefined;
  readonly exp: number;
  readonly iat?: number | undefined;
  readonly aud?: string | readonly string[] | undefined;
};

const accessTokenClaimsSchema = v.strictObject({
  sub: v.string(),
  org_id: v.optional(v.string()),
  scope: v.optional(v.string()),
  exp: v.number(),
  iat: v.optional(v.number()),
  aud: v.optional(v.union([v.string(), v.array(v.string())])),
});

/**
 * Decodes a JWT's payload segment without verifying its signature. Returns
 * `undefined` for opaque (non-JWT) tokens or malformed payloads.
 */
export const decodeAccessTokenClaims = (
  accessToken: string,
): AccessTokenClaims | undefined => {
  const segments = accessToken.split(".");
  const payloadSegment = segments.length === 3 ? segments.at(1) : undefined;
  if (!payloadSegment) {
    return undefined;
  }

  const decoded = Result.try((): unknown =>
    JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf-8")),
  );
  if (Result.isError(decoded)) {
    return undefined;
  }

  const parsed = v.safeParse(accessTokenClaimsSchema, decoded.value);
  return parsed.success ? parsed.output : undefined;
};
