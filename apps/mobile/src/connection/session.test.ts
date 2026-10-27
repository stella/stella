import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { Fetch } from "./http";
import {
  createAccessTokenSource,
  createSessionStore,
  EARLY_REFRESH_MS,
  type SessionGeneration,
  type StoredSession,
} from "./session";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
};

/** A token endpoint that rotates refresh tokens, counting what it is asked. */
const rotatingTokenEndpoint = () => {
  const presented: string[] = [];
  const fetch: Fetch = async (_input, init) => {
    const body = new URLSearchParams(
      typeof init?.body === "string" ? init.body : "",
    );
    const refreshToken = body.get("refresh_token") ?? "";
    presented.push(refreshToken);
    const generation = presented.length;
    return Response.json({
      access_token: `access-${generation}`,
      expires_in: 900,
      refresh_token: `refresh-${generation + 1}`,
      token_type: "Bearer",
    });
  };
  return { fetch, presented };
};

const memoryStore = (initial: StoredSession | undefined) => {
  let stored = initial;
  const store = createSessionStore({
    read: async () => stored,
    write: async (session) => {
      stored = session;
    },
    clear: async () => {
      stored = undefined;
    },
  });
  return { store, stored: () => stored };
};

const deferredPersistence = () => {
  type Pending = { readonly apply: () => void; readonly resolve: () => void };
  let stored: StoredSession | undefined;
  const pending: Pending[] = [];
  const waiters: (() => void)[] = [];
  const defer = async (apply: () => void) =>
    await new Promise<void>((resolve) => {
      pending.push({ apply, resolve });
      for (const wake of waiters.splice(0)) {
        wake();
      }
    });

  return {
    adapter: {
      read: async () => stored,
      write: async (session: StoredSession) => {
        await defer(() => {
          stored = session;
        });
      },
      clear: async () => {
        await defer(() => {
          stored = undefined;
        });
      },
    },
    pending: () => pending.length,
    reached: async (count: number) => {
      while (pending.length < count) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
    resolve: (index: number) => {
      const operation = pending.splice(index, 1).at(0);
      expect(operation).toBeDefined();
      operation?.apply();
      operation?.resolve();
    },
    stored: () => stored,
  };
};

const token = async (source: ReturnType<typeof createAccessTokenSource>) => {
  const result = await source.accessToken();
  return result.isOk() ? result.value : result.error._tag;
};

describe("access tokens", () => {
  test("a held token is used until it nears expiry, then refreshed once", async () => {
    let clock = 1_000_000;
    const endpoint = rotatingTokenEndpoint();
    const memory = memoryStore(SESSION);
    const source = createAccessTokenSource({
      fetch: endpoint.fetch,
      initialAccess: { token: "access-0", expiresAt: clock + 900_000 },
      now: () => clock,
      session: SESSION,
      generation: memory.store.generation(),
      store: memory.store,
    });

    expect(await token(source)).toBe("access-0");
    clock += 900_000 - EARLY_REFRESH_MS - 1;
    expect(await token(source)).toBe("access-0");
    clock += 1;
    expect(await token(source)).toBe("access-1");
    expect(await token(source)).toBe("access-1");
    expect(endpoint.presented).toEqual(["refresh-1"]);
  });

  test("concurrent callers share one refresh, so a rotated token is never replayed", async () => {
    const endpoint = rotatingTokenEndpoint();
    const memory = memoryStore(SESSION);
    const source = createAccessTokenSource({
      fetch: endpoint.fetch,
      initialAccess: undefined,
      now: () => 0,
      session: SESSION,
      generation: memory.store.generation(),
      store: memory.store,
    });

    const tokens = await Promise.all([
      token(source),
      token(source),
      token(source),
    ]);

    expect(tokens).toEqual(["access-1", "access-1", "access-1"]);
    expect(endpoint.presented).toEqual(["refresh-1"]);
    expect(memory.stored()?.refreshToken).toBe("refresh-2");

    source.invalidate();
    expect(await token(source)).toBe("access-2");
    expect(endpoint.presented).toEqual(["refresh-1", "refresh-2"]);
  });

  test("a grant the server ended signs the app out and forgets it", async () => {
    const memory = memoryStore(SESSION);
    const source = createAccessTokenSource({
      fetch: async () =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      initialAccess: undefined,
      now: () => 0,
      session: SESSION,
      generation: memory.store.generation(),
      store: memory.store,
    });

    expect(await token(source)).toBe("SignedOutError");
    expect(memory.stored()).toBeUndefined();
  });

  test("an unreachable server keeps the session for the next attempt", async () => {
    const memory = memoryStore(SESSION);
    let reachable = false;
    const endpoint = rotatingTokenEndpoint();
    const source = createAccessTokenSource({
      fetch: async (input, init) => {
        if (!reachable) {
          throw new TypeError("Network request failed");
        }
        return await endpoint.fetch(input, init);
      },
      initialAccess: undefined,
      now: () => 0,
      session: SESSION,
      generation: memory.store.generation(),
      store: memory.store,
    });

    expect(await token(source)).toBe("TokenError");
    expect(memory.stored()).toEqual(SESSION);
    reachable = true;
    expect(await token(source)).toBe("access-1");
  });

  test("a refresh resolving after sign-out cannot restore credentials", async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    const memory = memoryStore(SESSION);
    const source = createAccessTokenSource({
      fetch: async () =>
        await new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        }),
      initialAccess: undefined,
      now: () => 0,
      session: SESSION,
      generation: memory.store.generation(),
      store: memory.store,
    });

    const refreshing = token(source);
    await Promise.resolve();
    await memory.store.clear();
    resolveRefresh?.(
      Response.json({
        access_token: "late-access",
        expires_in: 900,
        refresh_token: "late-refresh",
        token_type: "Bearer",
      }),
    );

    expect(await refreshing).toBe("SignedOutError");
    expect(memory.stored()).toBeUndefined();
    expect(await token(source)).toBe("SignedOutError");
    expect(memory.stored()).toBeUndefined();
  });

  test("a superseded sign-in cannot publish after its write resolves", async () => {
    const persistence = deferredPersistence();
    const store = createSessionStore(persistence.adapter);
    let published: StoredSession | undefined;
    const sessionA = { ...SESSION, refreshToken: "sign-in-a" };
    const sessionB = { ...SESSION, refreshToken: "sign-in-b" };

    const signIn = async (session: StoredSession) => {
      const generation = store.advance();
      const outcome = await store.write(session, generation);
      if (outcome.type === "committed" && store.isCurrent(outcome.generation)) {
        published = session;
      }
      return outcome;
    };

    const pendingA = signIn(sessionA);
    await persistence.reached(1);
    const pendingB = signIn(sessionB);
    persistence.resolve(0);
    expect(await pendingA).toEqual({ type: "stale" });
    expect(published).toBeUndefined();
    await persistence.reached(1);
    persistence.resolve(0);

    expect(await pendingB).toEqual({
      type: "committed",
      generation: store.generation(),
    });
    expect(published).toEqual(sessionB);
    expect(persistence.stored()).toEqual(sessionB);
  });

  test("a sign-out supersedes a sign-in whose write is pending", async () => {
    const persistence = deferredPersistence();
    const store = createSessionStore(persistence.adapter);
    let published: StoredSession | undefined;

    const generation = store.advance();
    const pendingSignIn = store.write(SESSION, generation).then((outcome) => {
      if (outcome.type === "committed" && store.isCurrent(outcome.generation)) {
        published = SESSION;
      }
      return outcome;
    });
    await persistence.reached(1);
    const pendingSignOut = store.clear().then(() => {
      published = undefined;
      return undefined;
    });
    persistence.resolve(0);

    expect(await pendingSignIn).toEqual({ type: "stale" });
    expect(published).toBeUndefined();
    await persistence.reached(1);
    persistence.resolve(0);
    await pendingSignOut;
    expect(persistence.stored()).toBeUndefined();
    expect(published).toBeUndefined();
  });

  test("credentials follow session generations across event interleavings", async () => {
    type Event = "sign-in" | "sign-out" | "resolve";
    const event = fc.constantFrom<Event>("sign-in", "sign-out", "resolve");

    await assertProperty(
      "credentials follow session generations across event interleavings",
      fc.asyncProperty(fc.array(event, { maxLength: 40 }), async (events) => {
        const persistence = deferredPersistence();
        const store = createSessionStore(persistence.adapter);
        const mutations: Promise<void>[] = [];
        let expected: StoredSession | undefined;
        const model: {
          completed: number;
          published:
            | { session: StoredSession; generation: SessionGeneration }
            | undefined;
        } = { completed: 0, published: undefined };
        let sequence = 1;

        for (const currentEvent of events) {
          if (currentEvent === "sign-in") {
            const session = {
              ...SESSION,
              refreshToken: `sign-in-${sequence++}`,
            };
            expected = session;
            const generation = store.advance();
            mutations.push(
              store
                .write(session, generation)
                .then((outcome) => {
                  if (
                    outcome.type === "committed" &&
                    store.isCurrent(outcome.generation)
                  ) {
                    model.published = {
                      session,
                      generation: outcome.generation,
                    };
                  }
                  return undefined;
                })
                .finally(() => {
                  model.completed += 1;
                }),
            );
          } else if (currentEvent === "sign-out") {
            expected = undefined;
            const clearing = store.clear();
            const generation = store.generation();
            mutations.push(
              clearing
                .then(() => {
                  if (store.isCurrent(generation)) {
                    model.published = undefined;
                  }
                  return undefined;
                })
                .finally(() => {
                  model.completed += 1;
                }),
            );
          } else if (persistence.pending() > 0) {
            persistence.resolve(
              fc.sample(
                fc.integer({ min: 0, max: persistence.pending() - 1 }),
                1,
              )[0] ?? 0,
            );
            await Promise.resolve();
          }

          if (model.published !== undefined) {
            expect(store.isCurrent(model.published.generation)).toBeTrue();
          }
        }

        const settleMutations = async (): Promise<void> => {
          if (model.completed === mutations.length) {
            return;
          }
          if (persistence.pending() > 0) {
            persistence.resolve(0);
          }
          await Promise.resolve();
          await settleMutations();
        };
        await settleMutations();
        await Promise.all(mutations);
        expect(persistence.stored()).toEqual(expected);
        expect(model.published?.session).toEqual(expected);
      }),
    );
  });
});
