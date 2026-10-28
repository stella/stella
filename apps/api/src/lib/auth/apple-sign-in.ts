/**
 * Sign in with Apple client secret and provider options.
 *
 * Apple has no static client secret: the token endpoint takes an ES256 JWT
 * signed with a Sign in with Apple key, naming the team (`iss`) and the
 * Services ID (`sub`). This module mints that JWT in process from the key, so
 * no operator ever pastes or rotates a pre-made secret. Which settings a
 * deployment supplies, and whether they are usable, is decided in
 * `lib/apple-sign-in-config.ts`.
 */
import { sign } from "node:crypto";

import { Temporal } from "@stll/time";

import type { AppleSignInSettings } from "@/api/lib/apple-sign-in-config";

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
