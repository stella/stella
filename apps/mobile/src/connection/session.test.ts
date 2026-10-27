import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { Fetch } from "./http";
import {
  createAccessTokenSource,
  createSessionStore,
  EARLY_REFRESH_MS,
  type SessionStore,
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

const token = async (source: ReturnType<typeof createAccessTokenSource>) => {
  const result = await source.accessToken();
  return result.isOk() ? result.value : result.error._tag;
};

describe("access tokens", () => {
  test("a held token is used until it nears expiry, then refreshed once", async () => {
    let clock = 1_000_000;
    const endpoint = rotatingTokenEndpoint();
    const source = createAccessTokenSource({
      fetch: endpoint.fetch,
      initialAccess: { token: "access-0", expiresAt: clock + 900_000 },
      now: () => clock,
      session: SESSION,
      store: memoryStore(SESSION).store,
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

  test("credentials follow session generations across event interleavings", async () => {
    type Event =
      | "refresh-start"
      | "refresh-resolve"
      | "refresh-fail"
      | "sign-out"
      | "sign-in";
    const event = fc.constantFrom<Event>(
      "refresh-start",
      "refresh-resolve",
      "refresh-fail",
      "sign-out",
      "sign-in",
    );

    await assertProperty(
      "credentials follow session generations across event interleavings",
      fc.asyncProperty(fc.array(event, { maxLength: 40 }), async (events) => {
        const memory = memoryStore(undefined);
        const pending: {
          generation: ReturnType<SessionStore["generation"]>;
          session: StoredSession;
        }[] = [];
        let expected: StoredSession | undefined;
        let sequence = 1;

        for (const currentEvent of events) {
          if (currentEvent === "sign-in") {
            expected = { ...SESSION, refreshToken: `sign-in-${sequence++}` };
            const generation = memory.store.advance();
            await memory.store.write(expected, generation);
          } else if (currentEvent === "sign-out") {
            expected = undefined;
            await memory.store.clear();
          } else if (currentEvent === "refresh-start") {
            pending.push({
              generation: memory.store.generation(),
              session: {
                ...SESSION,
                refreshToken: `refresh-${sequence++}`,
              },
            });
          } else {
            const refresh = pending.shift();
            if (refresh !== undefined && currentEvent === "refresh-resolve") {
              const stored = await memory.store.write(
                refresh.session,
                refresh.generation,
              );
              if (stored) {
                expected = refresh.session;
              }
            }
          }
          expect(memory.stored()).toEqual(expected);
        }
      }),
    );
  });
});
