/**
 * Sign in with Apple configuration: which settings a deployment supplies and
 * whether they form a usable whole.
 *
 * Kept outside `lib/auth` and free of `env`: the boot invariant in
 * `env-schema.ts`, which public routes load, and the provider configuration
 * in `auth.ts` both resolve the same settings through
 * {@link resolveAppleSignIn}, so a partial or unreadable configuration fails
 * boot instead of reaching a sign-in. Minting the client secret lives in
 * `lib/auth/apple-sign-in.ts`.
 */
import { Result, TaggedError } from "better-result";
import { createPrivateKey } from "node:crypto";
import type { KeyObject } from "node:crypto";

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
