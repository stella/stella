import { Result, TaggedError } from "better-result";
/**
 * Sign in with Apple configuration and client secret.
 *
 * Apple has no static client secret: the token endpoint takes an ES256 JWT
 * signed with a Sign in with Apple key, naming the team (`iss`) and the
 * Services ID (`sub`). This module mints that JWT in process from the key, so
 * no operator ever pastes or rotates a pre-made secret.
 *
 * Kept free of `env` and of the auth instance: the boot invariant in
 * `env-schema.ts` and the provider configuration in `auth.ts` both resolve
 * the same settings through {@link resolveAppleSignIn}, so a partial or
 * unreadable configuration fails boot instead of reaching a sign-in.
 */
import { createPrivateKey, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { Temporal } from "@stll/time";

export type AppleSignInInput = {
  APPLE_AUTH_CLIENT_ID?: string | undefined;
  APPLE_AUTH_TEAM_ID?: string | undefined;
  APPLE_AUTH_KEY_ID?: string | undefined;
  APPLE_AUTH_PRIVATE_KEY?: string | undefined;
};

export type AppleSignInSettings = {
  /** The Services ID the web flow signs in through. */
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: KeyObject;
};

export type AppleSignIn =
  { type: "disabled" } | ({ type: "enabled" } & AppleSignInSettings);

class AppleSignInConfigError extends TaggedError("AppleSignInConfigError")<{
  message: string;
}> {}

/** Apple issues team and key identifiers as ten uppercase alphanumerics. */
const APPLE_IDENTIFIER_PATTERN = /^[A-Z0-9]{10}$/u;
/** Apple signs client secrets only with P-256 keys (ES256). */
const APPLE_KEY_CURVE = "prime256v1";

/**
 * The `.p8` text as a secret store hands it over. Single-line stores often
 * carry it with escaped newlines; PEM base64 never contains a backslash, so
 * unescaping cannot alter a well-formed key.
 */
const readPrivateKey = (pem: string): KeyObject | null => {
  const parsed = Result.try(() =>
    createPrivateKey({ key: pem.replaceAll("\\n", "\n"), format: "pem" }),
  );
  if (Result.isError(parsed)) {
    return null;
  }
  const key = parsed.value;
  return key.asymmetricKeyType === "ec" &&
    key.asymmetricKeyDetails?.namedCurve === APPLE_KEY_CURVE
    ? key
    : null;
};

export const resolveAppleSignIn = ({
  APPLE_AUTH_CLIENT_ID,
  APPLE_AUTH_TEAM_ID,
  APPLE_AUTH_KEY_ID,
  APPLE_AUTH_PRIVATE_KEY,
}: AppleSignInInput): Result<AppleSignIn, AppleSignInConfigError> => {
  if (
    [
      APPLE_AUTH_CLIENT_ID,
      APPLE_AUTH_TEAM_ID,
      APPLE_AUTH_KEY_ID,
      APPLE_AUTH_PRIVATE_KEY,
    ].every((value) => value === undefined)
  ) {
    return Result.ok({ type: "disabled" });
  }
  if (
    APPLE_AUTH_CLIENT_ID === undefined ||
    APPLE_AUTH_TEAM_ID === undefined ||
    APPLE_AUTH_KEY_ID === undefined ||
    APPLE_AUTH_PRIVATE_KEY === undefined
  ) {
    return Result.err(
      new AppleSignInConfigError({
        message:
          "APPLE_AUTH_CLIENT_ID, APPLE_AUTH_TEAM_ID, APPLE_AUTH_KEY_ID and APPLE_AUTH_PRIVATE_KEY must be configured together.",
      }),
    );
  }
  if (
    !APPLE_IDENTIFIER_PATTERN.test(APPLE_AUTH_TEAM_ID) ||
    !APPLE_IDENTIFIER_PATTERN.test(APPLE_AUTH_KEY_ID)
  ) {
    return Result.err(
      new AppleSignInConfigError({
        message:
          "APPLE_AUTH_TEAM_ID and APPLE_AUTH_KEY_ID must be Apple's ten-character identifiers.",
      }),
    );
  }
  const privateKey = readPrivateKey(APPLE_AUTH_PRIVATE_KEY);
  if (privateKey === null) {
    return Result.err(
      new AppleSignInConfigError({
        message:
          "APPLE_AUTH_PRIVATE_KEY must be the PEM text of a Sign in with Apple key (.p8, P-256).",
      }),
    );
  }
  return Result.ok({
    type: "enabled",
    clientId: APPLE_AUTH_CLIENT_ID,
    teamId: APPLE_AUTH_TEAM_ID,
    keyId: APPLE_AUTH_KEY_ID,
    privateKey,
  });
};

/** The audience Apple requires in a client secret. */
export const APPLE_CLIENT_SECRET_AUDIENCE = "https://appleid.apple.com";
/**
 * Lifetime of each minted secret. Apple accepts up to six months; an hour
 * bounds what a secret leaked from a request log could be replayed for.
 */
export const APPLE_CLIENT_SECRET_LIFETIME_SECONDS = 60 * 60;
/** A secret this close to expiry is replaced before it is sent. */
const APPLE_CLIENT_SECRET_RENEWAL_SECONDS = 10 * 60;

const base64UrlJson = (value: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

type MintAppleClientSecretOptions = AppleSignInSettings & {
  issuedAtSeconds: number;
};

/** An ES256 client secret for Apple's token endpoint, per Apple's layout. */
const mintAppleClientSecret = ({
  clientId,
  teamId,
  keyId,
  privateKey,
  issuedAtSeconds,
}: MintAppleClientSecretOptions): string => {
  const header = base64UrlJson({ alg: "ES256", kid: keyId });
  const claims = base64UrlJson({
    iss: teamId,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + APPLE_CLIENT_SECRET_LIFETIME_SECONDS,
    aud: APPLE_CLIENT_SECRET_AUDIENCE,
    sub: clientId,
  });
  const signingInput = `${header}.${claims}`;
  // JWS ES256 carries the raw r||s pair, not node's default DER signature.
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
};

const nowSeconds = () =>
  Math.floor(Temporal.Now.instant().epochMilliseconds / 1000);

/**
 * The current client secret, minted on first use and again whenever the held
 * one is near expiry. Synchronous, because Better Auth reads the secret as a
 * plain option value at each authorization and token request.
 */
export const createAppleClientSecretSource = (
  settings: AppleSignInSettings,
  now: () => number = nowSeconds,
): (() => string) => {
  let held: { value: string; expiresAtSeconds: number } | null = null;
  return () => {
    const current = now();
    if (
      held === null ||
      held.expiresAtSeconds - current <= APPLE_CLIENT_SECRET_RENEWAL_SECONDS
    ) {
      held = {
        value: mintAppleClientSecret({ ...settings, issuedAtSeconds: current }),
        expiresAtSeconds: current + APPLE_CLIENT_SECRET_LIFETIME_SECONDS,
      };
    }
    return held.value;
  };
};

/**
 * Better Auth's Apple provider options. The provider keeps this object and
 * reads `clientSecret` whenever it needs it, so the getter hands out a fresh
 * secret without rebuilding the auth instance. Never spread this object: a
 * spread copies the secret the getter returned at that moment and freezes it.
 *
 * Accounts: Apple returns the name only on a user's first authorization and
 * the email (possibly a private relay address, `…@privaterelay.appleid.com`)
 * in every ID token. Relay addresses are accepted. Apple verifies them, issues
 * one per person per developer team, and requires apps to honour "Hide My
 * Email", so refusing them would refuse Apple's own sign-in. A relay address
 * cannot belong to anyone else, and implicit linking stays disabled
 * (`SOCIAL_ACCOUNT_LINKING_OPTIONS`), so it never joins an existing account:
 * a person who hides their email gets an account under the relay address,
 * and linking Apple to an account under a different address is refused.
 */
export const createAppleProviderOptions = (
  { clientId }: AppleSignInSettings,
  clientSecret: () => string,
) => ({
  clientId,
  // Every provider signs in through the authorization redirect only.
  disableIdTokenSignIn: true,
  get clientSecret() {
    return clientSecret();
  },
});
