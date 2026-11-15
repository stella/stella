import { Result, TaggedError } from "better-result";
import { importPKCS8, SignJWT } from "jose";

import { Temporal } from "@stll/time";

import type { ApnsCredentials } from "@/api/lib/push/apns-config";

/**
 * Apple refuses a provider token older than an hour and answers
 * `TooManyProviderTokenUpdates` to one replaced sooner than every twenty
 * minutes. A token is reused for fifty minutes, then signed afresh.
 */
export const APNS_PROVIDER_TOKEN_REFRESH_MS = 50 * 60_000;
export const APNS_PROVIDER_TOKEN_MIN_AGE_MS = 20 * 60_000;

export class ApnsProviderTokenError extends TaggedError(
  "ApnsProviderTokenError",
)<{
  message: string;
  cause?: unknown;
}> {}

export type ApnsProviderToken = {
  /** The token to send, signed now if none is fresh enough. */
  current: () => Promise<Result<string, ApnsProviderTokenError>>;
  /**
   * Apple called the token expired. It is dropped so the next request signs
   * a new one, unless it is younger than Apple's minimum refresh interval, in
   * which case the clocks disagree and signing again would only be refused.
   */
  expire: () => void;
};

type ProviderTokenOptions = {
  credentials: ApnsCredentials;
  now?: () => number;
  sign?: (
    credentials: ApnsCredentials,
    issuedAtSeconds: number,
  ) => Promise<string>;
};

const signWithKey = () => {
  // Only a parsed key is kept: a key that fails to parse is tried again on
  // the next signing rather than refused for the life of the process.
  let key: CryptoKey | null = null;
  return async (
    credentials: ApnsCredentials,
    issuedAtSeconds: number,
  ): Promise<string> => {
    const signingKey =
      key ?? (await importPKCS8(credentials.privateKeyPem, "ES256"));
    key = signingKey;
    return await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: credentials.keyId })
      .setIssuer(credentials.teamId)
      .setIssuedAt(issuedAtSeconds)
      .sign(signingKey);
  };
};

/**
 * The ES256 provider token APNs authenticates every request with (`iss` the
 * team id, `kid` the key id, `iat` the signing time), cached for the process.
 * Concurrent requests share one signing.
 */
export const createApnsProviderToken = ({
  credentials,
  now = () => Temporal.Now.instant().epochMilliseconds,
  sign = signWithKey(),
}: ProviderTokenOptions): ApnsProviderToken => {
  let cached: { token: string; issuedAtMs: number } | null = null;
  let signing: Promise<Result<string, ApnsProviderTokenError>> | null = null;

  const signFresh = async (): Promise<
    Result<string, ApnsProviderTokenError>
  > => {
    const issuedAtMs = now();
    const signed = await Result.tryPromise({
      try: async () => await sign(credentials, Math.floor(issuedAtMs / 1000)),
      catch: (cause) =>
        new ApnsProviderTokenError({
          message: "Could not sign the APNs provider token",
          cause,
        }),
    });
    if (Result.isOk(signed)) {
      cached = { token: signed.value, issuedAtMs };
    }
    return signed;
  };

  return {
    current: async () => {
      if (
        cached !== null &&
        now() - cached.issuedAtMs < APNS_PROVIDER_TOKEN_REFRESH_MS
      ) {
        return Result.ok(cached.token);
      }
      signing ??= signFresh().finally(() => {
        signing = null;
      });
      return await signing;
    },
    expire: () => {
      if (
        cached !== null &&
        now() - cached.issuedAtMs >= APNS_PROVIDER_TOKEN_MIN_AGE_MS
      ) {
        cached = null;
      }
    },
  };
};
