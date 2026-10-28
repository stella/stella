import { describe, expect, test } from "bun:test";

import type { Fetch } from "./http";
import {
  createAccessTokenSource,
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
  const store: SessionStore = {
    read: async () => stored,
    write: async (session) => {
      stored = session;
    },
    clear: async () => {
      stored = undefined;
    },
  };
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

  test("a grant another run rotated first continues from the token it kept", async () => {
    const successor = { ...SESSION, refreshToken: "refresh-2" };
    const memory = memoryStore(successor);
    const presented: string[] = [];
    const source = createAccessTokenSource({
      fetch: async (_input, init) => {
        const body = new URLSearchParams(
          typeof init?.body === "string" ? init.body : "",
        );
        const refreshToken = body.get("refresh_token") ?? "";
        presented.push(refreshToken);
        return refreshToken === "refresh-2"
          ? Response.json({
              access_token: "access-2",
              expires_in: 900,
              refresh_token: "refresh-3",
              token_type: "Bearer",
            })
          : Response.json({ error: "invalid_grant" }, { status: 400 });
      },
      initialAccess: undefined,
      now: () => 0,
      session: SESSION,
      store: memory.store,
    });

    expect(await token(source)).toBe("access-2");
    expect(presented).toEqual(["refresh-1", "refresh-2"]);
    expect(memory.stored()?.refreshToken).toBe("refresh-3");
  });

  test("a session kept for another server is neither adopted nor cleared", async () => {
    // A server controls its own discovery document, so it can claim another
    // server's issuer, client, endpoints and resource; only its URL differs.
    const other: StoredSession = {
      ...SESSION,
      serverUrl: "https://other.example.com",
      refreshToken: "other-refresh",
    };
    const memory = memoryStore(other);
    const presented: string[] = [];
    const source = createAccessTokenSource({
      fetch: async (_input, init) => {
        const body = new URLSearchParams(
          typeof init?.body === "string" ? init.body : "",
        );
        presented.push(body.get("refresh_token") ?? "");
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      },
      initialAccess: undefined,
      now: () => 0,
      session: SESSION,
      store: memory.store,
    });

    expect(await token(source)).toBe("SignedOutError");
    expect(presented).toEqual(["refresh-1"]);
    expect(memory.stored()).toEqual(other);
  });

  test("an adopted token refused after another run rotated again keeps the newer one", async () => {
    // This source adopts refresh-2, which the server then refuses because a
    // third run has since rotated it and kept refresh-3.
    const memory = memoryStore({ ...SESSION, refreshToken: "refresh-2" });
    const source = createAccessTokenSource({
      fetch: async (_input, init) => {
        const body = new URLSearchParams(
          typeof init?.body === "string" ? init.body : "",
        );
        if (body.get("refresh_token") === "refresh-2") {
          await memory.store.write({ ...SESSION, refreshToken: "refresh-3" });
        }
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      },
      initialAccess: undefined,
      now: () => 0,
      session: SESSION,
      store: memory.store,
    });

    expect(await token(source)).toBe("SignedOutError");
    expect(memory.stored()?.refreshToken).toBe("refresh-3");
  });

  test("a keychain that cannot be read is not cleared", async () => {
    let cleared = false;
    const source = createAccessTokenSource({
      fetch: async () =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      initialAccess: undefined,
      now: () => 0,
      session: SESSION,
      store: {
        read: async () => {
          throw new Error("The keychain is locked");
        },
        write: async () => undefined,
        clear: async () => {
          cleared = true;
        },
      },
    });

    expect(await token(source)).toBe("SignedOutError");
    expect(cleared).toBe(false);
  });

  test("a keychain that cannot be cleared still signs the app out", async () => {
    const source = createAccessTokenSource({
      fetch: async () =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      initialAccess: undefined,
      now: () => 0,
      session: SESSION,
      store: {
        read: async () => SESSION,
        write: async () => undefined,
        clear: async () => {
          throw new Error("The keychain is locked");
        },
      },
    });

    expect(await token(source)).toBe("SignedOutError");
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
});
