import { Result } from "better-result";
import * as v from "valibot";

import { SignedOutError, TokenError } from "./errors";
import type { Fetch } from "./http";
import { refreshTokens } from "./tokens";

/**
 * What survives a restart, in the platform keychain. The access token is
 * deliberately absent: it lives in memory only, so the stored secret is the
 * refresh token alone, which the server can revoke and rotates on use.
 */
export const storedSessionSchema = v.object({
  serverUrl: v.pipe(v.string(), v.url()),
  issuer: v.pipe(v.string(), v.url()),
  clientId: v.pipe(v.string(), v.minLength(1)),
  tokenEndpoint: v.pipe(v.string(), v.url()),
  /** RFC 7009; sign-out revokes the grant here when the server offers it. */
  revocationEndpoint: v.optional(v.pipe(v.string(), v.url())),
  resource: v.pipe(v.string(), v.url()),
  refreshToken: v.pipe(v.string(), v.minLength(1)),
});

export type StoredSession = v.InferOutput<typeof storedSessionSchema>;

type SessionPersistence = {
  readonly read: () => Promise<StoredSession | undefined>;
  readonly write: (session: StoredSession) => Promise<void>;
  readonly clear: () => Promise<void>;
};

const sessionGenerationBrand = Symbol("session-generation");
export type SessionGeneration = {
  readonly [sessionGenerationBrand]: true;
};

export type SessionStore = {
  readonly read: () => Promise<StoredSession | undefined>;
  readonly generation: () => SessionGeneration;
  readonly advance: () => SessionGeneration;
  readonly isCurrent: (generation: SessionGeneration) => boolean;
  readonly write: (
    session: StoredSession,
    generation: SessionGeneration,
  ) => Promise<boolean>;
  readonly clear: () => Promise<void>;
};

/** Owns every credential mutation and orders it against session generation changes. */
export const createSessionStore = (
  persistence: SessionPersistence,
): SessionStore => {
  let generation: SessionGeneration = { [sessionGenerationBrand]: true };
  let mutations = Promise.resolve();

  const advance = (): SessionGeneration => {
    generation = { [sessionGenerationBrand]: true };
    return generation;
  };
  const enqueue = async <Value>(mutation: () => Promise<Value>) => {
    const pending = mutations.then(mutation, mutation);
    mutations = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  };

  return {
    read: persistence.read,
    generation: () => generation,
    advance,
    isCurrent: (captured) => captured === generation,
    write: async (session, captured) =>
      await enqueue(async () => {
        if (captured !== generation) {
          return false;
        }
        await persistence.write(session);
        return true;
      }),
    clear: async () => {
      advance();
      await enqueue(persistence.clear);
    },
  };
};

export type AccessToken = {
  readonly token: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
};

/** Refresh this long before expiry, so a request never leaves with a token about to lapse. */
export const EARLY_REFRESH_MS = 60_000;

/** OAuth errors after which the stored grant can never work again (RFC 6749 §5.2). */
const TERMINAL_REFRESH_ERRORS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
]);

export type AccessTokenSource = {
  readonly session: () => StoredSession;
  /** A current access token, refreshing first when the held one is spent. */
  readonly accessToken: () => Promise<
    Result<string, SignedOutError | TokenError>
  >;
  /** After the server rejects a token it is spent, whatever its clock says. */
  readonly invalidate: () => void;
};

/**
 * Hands out access tokens for one signed-in session. Concurrent callers
 * share one refresh: refresh tokens rotate, so a second refresh racing the
 * first would present a token the server already retired.
 */
export const createAccessTokenSource = ({
  fetch,
  initialAccess,
  now,
  session,
  store,
}: {
  readonly fetch: Fetch;
  readonly initialAccess: AccessToken | undefined;
  readonly now: () => number;
  readonly session: StoredSession;
  readonly store: SessionStore;
}): AccessTokenSource => {
  let current = session;
  let access = initialAccess;
  const generation = store.generation();
  let refreshing:
    Promise<Result<string, SignedOutError | TokenError>> | undefined;

  const refresh = async (): Promise<
    Result<string, SignedOutError | TokenError>
  > => {
    if (!store.isCurrent(generation)) {
      return Result.err(
        new SignedOutError({ message: "The session is no longer current" }),
      );
    }
    const refreshed = await refreshTokens({
      fetch,
      clientId: current.clientId,
      refreshToken: current.refreshToken,
      resource: current.resource,
      tokenEndpoint: current.tokenEndpoint,
    });
    if (Result.isError(refreshed)) {
      const { oauthError } = refreshed.error;
      if (oauthError !== undefined && TERMINAL_REFRESH_ERRORS.has(oauthError)) {
        await store.clear();
        return Result.err(
          new SignedOutError({
            message: `The server ended the session: ${oauthError}`,
          }),
        );
      }
      return Result.err(refreshed.error);
    }
    const tokens = refreshed.value;
    if (
      tokens.refresh_token !== undefined &&
      tokens.refresh_token !== current.refreshToken
    ) {
      current = { ...current, refreshToken: tokens.refresh_token };
      const persisted = await Result.tryPromise({
        try: async () => await store.write(current, generation),
        catch: (cause) =>
          new TokenError({
            message: "Could not keep the rotated session",
            cause,
          }),
      });
      if (Result.isError(persisted)) {
        return Result.err(persisted.error);
      }
      if (!persisted.value) {
        return Result.err(
          new SignedOutError({ message: "The session is no longer current" }),
        );
      }
    }
    if (!store.isCurrent(generation)) {
      return Result.err(
        new SignedOutError({ message: "The session is no longer current" }),
      );
    }
    access = {
      token: tokens.access_token,
      expiresAt: now() + tokens.expires_in * 1000,
    };
    return Result.ok(tokens.access_token);
  };

  return {
    session: () => current,
    accessToken: async () => {
      if (access !== undefined && access.expiresAt - EARLY_REFRESH_MS > now()) {
        return Result.ok(access.token);
      }
      refreshing ??= refresh().finally(() => {
        refreshing = undefined;
      });
      return await refreshing;
    },
    invalidate: () => {
      access = undefined;
    },
  };
};
