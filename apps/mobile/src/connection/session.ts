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
  /** Local sign-in identity, preserved across refresh-token rotations. */
  signInId: v.pipe(v.string(), v.minLength(1)),
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
  /** `null` marks an unusable entry (a tombstone or invalid stored shape). */
  readonly read: () => Promise<StoredSession | null | undefined>;
  readonly write: (session: StoredSession) => Promise<void>;
  readonly prepareClear: () => Promise<void>;
  readonly clear: () => Promise<void>;
};

const sessionGenerationBrand = Symbol("session-generation");
export type SessionGeneration = {
  readonly [sessionGenerationBrand]: true;
};

export type SessionWriteOutcome =
  | { readonly type: "committed"; readonly generation: SessionGeneration }
  | { readonly type: "stale" };

export type SessionTransition = {
  readonly generation: SessionGeneration;
  readonly write: (session: StoredSession) => Promise<SessionWriteOutcome>;
  readonly clear: () => Promise<SessionWriteOutcome>;
};

export type SessionStore = {
  readonly read: (
    generation: SessionGeneration,
  ) => Promise<StoredSession | undefined>;
  readonly commit: <Value>(
    generation: SessionGeneration,
    publish: () => Value,
  ) => Value | undefined;
  readonly generation: () => SessionGeneration;
  readonly advance: () => SessionGeneration;
  readonly begin: () => SessionTransition;
  readonly isCurrent: (generation: SessionGeneration) => boolean;
  readonly write: (
    session: StoredSession,
    generation: SessionGeneration,
  ) => Promise<SessionWriteOutcome>;
  readonly clear: (
    generation: SessionGeneration,
    expected?: StoredSession,
  ) => Promise<SessionWriteOutcome>;
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

  const store: SessionStore = {
    read: async (captured) => {
      const session = await persistence.read();
      if (session === null) {
        await enqueue(async () => {
          if (captured !== generation) {
            return;
          }
          const current = await persistence.read();
          if (captured === generation && current === null) {
            await persistence.clear();
          }
        });
        return undefined;
      }
      return captured === generation ? session : undefined;
    },
    commit: (captured, publish) =>
      captured === generation ? publish() : undefined,
    generation: () => generation,
    advance,
    begin: () => {
      const captured = advance();
      return {
        generation: captured,
        write: async (session) => await store.write(session, captured),
        clear: async () => await store.clear(captured),
      };
    },
    isCurrent: (captured) => captured === generation,
    write: async (session, captured) =>
      await enqueue(async () => {
        if (captured !== generation) {
          return { type: "stale" };
        }
        await persistence.write(session);
        return captured === generation
          ? { type: "committed", generation: captured }
          : { type: "stale" };
      }),
    clear: async (captured, expected) =>
      await enqueue(async () => {
        if (captured !== generation) {
          return { type: "stale" };
        }
        if (expected !== undefined) {
          const kept = await persistence.read();
          if (captured !== generation) {
            return { type: "stale" };
          }
          if (
            kept !== undefined &&
            (kept === null ||
              !sameSessionIdentity(kept, expected) ||
              kept.refreshToken !== expected.refreshToken)
          ) {
            return { type: "stale" };
          }
        }
        await persistence.prepareClear();
        if (captured !== generation) {
          return { type: "stale" };
        }
        const current = await persistence.read();
        if (captured !== generation) {
          return { type: "stale" };
        }
        if (current === null) {
          await persistence.clear();
        }
        return captured === generation
          ? { type: "committed", generation: captured }
          : { type: "stale" };
      }),
  };
  return store;
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
  /** Metadata is unavailable once another transition owns the session. */
  readonly session: () => StoredSession | undefined;
  /** A current access token, refreshing first when the held one is spent. */
  readonly accessToken: () => Promise<
    Result<string, SignedOutError | TokenError>
  >;
  /** After the server rejects a token it is spent, whatever its clock says. */
  readonly invalidate: () => void;
};

/** Matches an asynchronous failure to the source that still owns the UI. */
export const isCurrentSessionSource = (
  current: AccessTokenSource | undefined,
  failed: AccessTokenSource,
): boolean => current === failed && failed.session() !== undefined;

/**
 * Hands out access tokens for one signed-in session. Concurrent callers
 * share one refresh: refresh tokens rotate, so a second refresh racing the
 * first would present a token the server already retired.
 */
export const createAccessTokenSource = ({
  fetch,
  generation,
  initialAccess,
  now,
  session,
  store,
}: {
  readonly fetch: Fetch;
  readonly initialAccess: AccessToken | undefined;
  readonly now: () => number;
  readonly session: StoredSession;
  readonly generation: SessionGeneration;
  readonly store: SessionStore;
}): AccessTokenSource => {
  let current = session;
  let access = initialAccess;
  let refreshing:
    Promise<Result<string, SignedOutError | TokenError>> | undefined;

  const afterRefusal = async (
    presented: string,
    oauthError: string,
    adopted: boolean,
  ): Promise<Result<string, SignedOutError | TokenError>> => {
    const kept = await Result.tryPromise(
      async () => await store.read(generation),
    );
    const successor = Result.isOk(kept) ? kept.value : undefined;
    const sameSession =
      store.isCurrent(generation) &&
      successor !== undefined &&
      sameSessionIdentity(successor, current);
    if (!adopted && sameSession && successor.refreshToken !== presented) {
      current = successor;
      return await refresh(true);
    }
    // Only a keychain read as empty or still holding the refused token is
    // cleared: a newer token another run stored, or a keychain that could
    // not be read, is left as it is.
    const refusedKept =
      Result.isOk(kept) &&
      (successor === undefined ||
        (sameSession && successor.refreshToken === presented));
    if (refusedKept) {
      (
        await Result.tryPromise(async () => {
          await store.clear(generation, current);
        })
      ).unwrapOr(undefined);
    }
    return Result.err(
      new SignedOutError({
        message: `The server ended the session: ${oauthError}`,
      }),
    );
  };

  const refresh = async (
    adopted = false,
  ): Promise<Result<string, SignedOutError | TokenError>> => {
    if (!store.isCurrent(generation)) {
      return Result.err(
        new SignedOutError({ message: "The session is no longer current" }),
      );
    }
    const presented = current.refreshToken;
    const refreshed = await refreshTokens({
      fetch,
      clientId: current.clientId,
      refreshToken: presented,
      resource: current.resource,
      tokenEndpoint: current.tokenEndpoint,
    });
    if (Result.isError(refreshed)) {
      const { oauthError } = refreshed.error;
      if (oauthError !== undefined && TERMINAL_REFRESH_ERRORS.has(oauthError)) {
        return await afterRefusal(presented, oauthError, adopted);
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
      if (persisted.value.type === "stale") {
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
    session: () => (store.isCurrent(generation) ? current : undefined),
    accessToken: async () => {
      if (!store.isCurrent(generation)) {
        return Result.err(
          new SignedOutError({ message: "The session is no longer current" }),
        );
      }
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

/** Whether two stored sessions are the same sign-in, whatever their refresh token. */
function sameSessionIdentity(a: StoredSession, b: StoredSession): boolean {
  return (
    a.signInId === b.signInId &&
    a.serverUrl === b.serverUrl &&
    a.issuer === b.issuer &&
    a.clientId === b.clientId &&
    a.tokenEndpoint === b.tokenEndpoint &&
    a.revocationEndpoint === b.revocationEndpoint &&
    a.resource === b.resource
  );
}
