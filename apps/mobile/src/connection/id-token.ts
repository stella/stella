// The person behind a sign-in, read from the ID token the code exchange
// returns. The token arrives straight from the token endpoint over TLS, so
// OpenID Connect Core §3.1.3.7 lets the client skip its signature; the
// issuer and audience are still checked, since a token for another client
// or server must not name this session's person.

import { Result } from "better-result";
import * as v from "valibot";

import { TokenError } from "./errors";

const claimsSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({
    iss: v.string(),
    aud: v.union([v.string(), v.array(v.string())]),
    sub: v.pipe(v.string(), v.minLength(1)),
  }),
);

/** RFC 4648 §5 base64url, padded or not, to its UTF-8 text. */
const decodeBase64Url = (encoded: string): string => {
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0),
  );
};

/**
 * The stable id of the signed-in person: the ID token's `sub`, once its
 * issuer is the server signed in to and its audience names this client.
 */
export const readIdTokenSubject = ({
  clientId,
  idToken,
  issuer,
}: {
  readonly clientId: string;
  readonly idToken: string;
  readonly issuer: string;
}): Result<string, TokenError> => {
  const payload = idToken.split(".").at(1);
  if (payload === undefined) {
    return Result.err(new TokenError({ message: "The ID token is not a JWT" }));
  }
  const decoded = Result.try({
    try: () => decodeBase64Url(payload),
    catch: (cause) =>
      new TokenError({ message: "The ID token could not be read", cause }),
  });
  if (Result.isError(decoded)) {
    return Result.err(decoded.error);
  }
  const claims = v.safeParse(claimsSchema, decoded.value);
  if (!claims.success) {
    return Result.err(
      new TokenError({
        message: "The ID token lacks its issuer, audience or subject",
        cause: new v.ValiError(claims.issues),
      }),
    );
  }
  const { iss, aud, sub } = claims.output;
  if (iss !== issuer) {
    return Result.err(
      new TokenError({ message: "The ID token names another issuer" }),
    );
  }
  const audiences = typeof aud === "string" ? [aud] : aud;
  return audiences.includes(clientId)
    ? Result.ok(sub)
    : Result.err(
        new TokenError({
          message: "The ID token was issued to another client",
        }),
      );
};
