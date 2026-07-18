import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readCredentialFile,
  removeCredential,
  upsertCredential,
  writeCredentialFile,
} from "./credential-store.js";
import type { StoredCredential } from "./credential-store.js";
import { resolveAccessToken } from "./resolve-access-token.js";

/**
 * A mock stella server exposing both the RFC 8414 metadata document and the
 * `/oauth2/token` endpoint, plus a total request counter so a test can assert
 * the offline-instant fast path made no network call at all.
 *
 * `onDiscovery`, when given, runs while the `.well-known` request is being
 * answered — a hook for simulating a concurrent `stella` process (e.g. a
 * parallel `auth login`) that writes to `credentials.json` during the window
 * `resolveAccessToken` spends awaiting metadata discovery. `handleTokenRequest`
 * may itself be async for the equivalent simulation around the token-endpoint
 * exchange.
 */
const startMockProvider = (
  handleTokenRequest: (body: URLSearchParams) => Response | Promise<Response>,
  onDiscovery?: () => Promise<void>,
) => {
  let requestCount = 0;
  const server = Bun.serve({
    // Derives the endpoint URLs from the incoming request's own origin
    // rather than `server.port` — referencing `server` from inside its own
    // `fetch` handler is a circular initializer TypeScript can't type
    // (`server`'s type depends on `fetch`'s type, which would depend on
    // `server`). `request.url` already carries the correct host:port.
    fetch: async (request) => {
      requestCount += 1;
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        await onDiscovery?.();
        return Response.json({
          authorization_endpoint: `${url.origin}/oauth2/authorize`,
          issuer: url.origin,
          token_endpoint: `${url.origin}/oauth2/token`,
        });
      }
      if (url.pathname === "/oauth2/token") {
        return await handleTokenRequest(
          new URLSearchParams(await request.text()),
        );
      }
      return new Response("not found", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });

  return {
    close: () => {
      void server.stop(true);
    },
    getRequestCount: () => requestCount,
    serverUrl: `http://127.0.0.1:${server.port}`,
  };
};

describe("resolveAccessToken", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-cli-resolve-token-test-"),
    );
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  const buildCredential = (
    serverUrl: string,
    overrides: Partial<StoredCredential> = {},
  ): StoredCredential => ({
    accessToken: "old-access-token",
    clientId: "client-id",
    createdAt: 0,
    expiresAt: 10_000,
    orgId: "org-1",
    refreshToken: "old-refresh-token",
    scope: "openid stella:read",
    serverUrl,
    tokenType: "Bearer",
    updatedAt: 0,
    ...overrides,
  });

  const seedCredential = async (
    credential: StoredCredential,
  ): Promise<void> => {
    await writeCredentialFile(
      configDir,
      upsertCredential(
        { credentials: [], defaultOrgByServer: {}, version: 1 },
        credential,
      ),
    );
  };

  test("returns the stored token with no network call when the credential is comfortably valid", async () => {
    const provider = startMockProvider(
      () => new Response("should not be called", { status: 500 }),
    );
    try {
      const now = Date.now();
      await seedCredential(
        buildCredential(provider.serverUrl, { expiresAt: now + 60_000 }),
      );

      const result = await resolveAccessToken({
        configDir,
        serverUrl: provider.serverUrl,
        now,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.token).toBe("old-access-token");
      }
      expect(provider.getRequestCount()).toBe(0);
    } finally {
      provider.close();
    }
  });

  test("refreshes, persists, and returns the rotated token when the stored token is expired", async () => {
    const provider = startMockProvider((body) =>
      body.get("grant_type") === "refresh_token" &&
      body.get("refresh_token") === "old-refresh-token"
        ? Response.json({
            access_token: "new-access-token",
            expires_in: 900,
            refresh_token: "new-refresh-token",
            scope: "openid stella:read",
            token_type: "Bearer",
          })
        : Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    try {
      const now = Date.now();
      await seedCredential(
        buildCredential(provider.serverUrl, { expiresAt: now - 1000 }),
      );

      const result = await resolveAccessToken({
        configDir,
        serverUrl: provider.serverUrl,
        now,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.token).toBe("new-access-token");
      }

      const persisted = await readCredentialFile(configDir);
      const stored = persisted.credentials.at(0);
      expect(stored?.accessToken).toBe("new-access-token");
      expect(stored?.refreshToken).toBe("new-refresh-token");
      expect(stored?.expiresAt).toBe(now + 900 * 1000);
    } finally {
      provider.close();
    }
  });

  test("reports refresh-failed when the token endpoint rejects the refresh", async () => {
    const provider = startMockProvider(() =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    try {
      const now = Date.now();
      await seedCredential(
        buildCredential(provider.serverUrl, { expiresAt: now - 1000 }),
      );

      const result = await resolveAccessToken({
        configDir,
        serverUrl: provider.serverUrl,
        now,
      });

      expect(result.status).toBe("refresh-failed");
      if (result.status === "refresh-failed") {
        expect(result.error._tag).toBe("TokenRefreshError");
      }
    } finally {
      provider.close();
    }
  });

  test("reports refresh-failed without a network call when the expired credential has no refresh token", async () => {
    const provider = startMockProvider(
      () => new Response("should not be called", { status: 500 }),
    );
    try {
      const now = Date.now();
      await seedCredential(
        buildCredential(provider.serverUrl, {
          expiresAt: now - 1000,
          refreshToken: undefined,
        }),
      );

      const result = await resolveAccessToken({
        configDir,
        serverUrl: provider.serverUrl,
        now,
      });

      expect(result.status).toBe("refresh-failed");
      if (result.status === "refresh-failed") {
        expect(result.error._tag).toBe("NoRefreshTokenError");
      }
      expect(provider.getRequestCount()).toBe(0);
    } finally {
      provider.close();
    }
  });

  test("reports unauthenticated when no credential is stored for the server", async () => {
    const provider = startMockProvider(
      () => new Response("should not be called", { status: 500 }),
    );
    try {
      const result = await resolveAccessToken({
        configDir,
        serverUrl: provider.serverUrl,
        now: Date.now(),
      });

      expect(result.status).toBe("unauthenticated");
      expect(provider.getRequestCount()).toBe(0);
    } finally {
      provider.close();
    }
  });

  test("does not clobber a credential a concurrent process writes while metadata discovery is in flight", async () => {
    const otherServerUrl = "https://other.example";
    let discoveryRequestCount = 0;
    const provider = startMockProvider(
      (body) =>
        body.get("grant_type") === "refresh_token" &&
        body.get("refresh_token") === "old-refresh-token"
          ? Response.json({
              access_token: "new-access-token",
              expires_in: 900,
              refresh_token: "new-refresh-token",
              scope: "openid stella:read",
              token_type: "Bearer",
            })
          : Response.json({ error: "invalid_grant" }, { status: 400 }),
      async () => {
        discoveryRequestCount += 1;
        // Simulate a concurrent `stella` process (e.g. `auth login` to a
        // different server) finishing a write to `credentials.json` while
        // this command's metadata discovery request is still in flight.
        const concurrent = await readCredentialFile(configDir);
        await writeCredentialFile(
          configDir,
          upsertCredential(
            concurrent,
            buildCredential(otherServerUrl, {
              accessToken: "other-server-token",
            }),
          ),
        );
      },
    );
    try {
      const now = Date.now();
      await seedCredential(
        buildCredential(provider.serverUrl, { expiresAt: now - 1000 }),
      );

      const result = await resolveAccessToken({
        configDir,
        serverUrl: provider.serverUrl,
        now,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.token).toBe("new-access-token");
      }
      expect(discoveryRequestCount).toBe(1);

      // The concurrently-written credential for the other server must
      // survive this command's refresh write-back rather than being
      // silently dropped by a stale pre-discovery snapshot of
      // `credentials.json`.
      const persisted = await readCredentialFile(configDir);
      expect(
        persisted.credentials.find(
          (stored) => stored.serverUrl === otherServerUrl,
        )?.accessToken,
      ).toBe("other-server-token");
    } finally {
      provider.close();
    }
  });

  test("does not clobber a credential a concurrent process writes during the token-endpoint exchange", async () => {
    const otherServerUrl = "https://other-exchange.example";
    let tokenRequestCount = 0;
    const provider = startMockProvider(async (body) => {
      tokenRequestCount += 1;
      if (
        body.get("grant_type") !== "refresh_token" ||
        body.get("refresh_token") !== "old-refresh-token"
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      // Simulate a concurrent `stella` process (e.g. `auth login` to a
      // different server) finishing a write to `credentials.json` while the
      // token-endpoint exchange itself — not just metadata discovery — is
      // still in flight.
      const concurrent = await readCredentialFile(configDir);
      await writeCredentialFile(
        configDir,
        upsertCredential(
          concurrent,
          buildCredential(otherServerUrl, {
            accessToken: "other-exchange-token",
          }),
        ),
      );
      return Response.json({
        access_token: "new-access-token",
        expires_in: 900,
        refresh_token: "new-refresh-token",
        scope: "openid stella:read",
        token_type: "Bearer",
      });
    });
    try {
      const now = Date.now();
      await seedCredential(
        buildCredential(provider.serverUrl, { expiresAt: now - 1000 }),
      );

      const result = await resolveAccessToken({
        configDir,
        serverUrl: provider.serverUrl,
        now,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.token).toBe("new-access-token");
      }
      expect(tokenRequestCount).toBe(1);

      // The concurrently-written credential for the other server must
      // survive `ensureFreshCredential`'s write-back rather than being
      // silently dropped by a snapshot taken before the token exchange.
      const persisted = await readCredentialFile(configDir);
      expect(
        persisted.credentials.find(
          (stored) => stored.serverUrl === otherServerUrl,
        )?.accessToken,
      ).toBe("other-exchange-token");
    } finally {
      provider.close();
    }
  });

  test("does not resurrect a credential a concurrent auth logout removes mid-exchange", async () => {
    let tokenRequestCount = 0;
    const provider = startMockProvider(async (body) => {
      tokenRequestCount += 1;
      if (
        body.get("grant_type") !== "refresh_token" ||
        body.get("refresh_token") !== "old-refresh-token"
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      // Simulate a concurrent `stella auth logout` removing this exact
      // credential while the token-endpoint exchange (which still succeeds
      // at the network level) is in flight. Reads the target's own
      // serverUrl/orgId back off disk rather than closing over `provider`
      // (not yet assigned while this callback is being constructed).
      const concurrent = await readCredentialFile(configDir);
      const target = concurrent.credentials.at(0);
      if (target === undefined) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      await writeCredentialFile(
        configDir,
        removeCredential(concurrent, target.serverUrl, target.orgId),
      );
      return Response.json({
        access_token: "resurrected-access-token",
        expires_in: 900,
        refresh_token: "resurrected-refresh-token",
        scope: "openid stella:read",
        token_type: "Bearer",
      });
    });
    try {
      const now = Date.now();
      await seedCredential(
        buildCredential(provider.serverUrl, { expiresAt: now - 1000 }),
      );

      const result = await resolveAccessToken({
        configDir,
        serverUrl: provider.serverUrl,
        now,
      });

      // Logout wins: the exchange happened, but the credential it would
      // have refreshed is gone, so this resolves the same as "never signed
      // in" rather than handing back the resurrected token.
      expect(result.status).toBe("unauthenticated");
      expect(tokenRequestCount).toBe(1);

      // The logged-out credential must not reappear on disk, and
      // specifically not carrying the token from the (already-in-flight)
      // exchange that should never have been written back.
      const persisted = await readCredentialFile(configDir);
      expect(
        persisted.credentials.find(
          (stored) =>
            stored.serverUrl === provider.serverUrl && stored.orgId === "org-1",
        ),
      ).toBeUndefined();
    } finally {
      provider.close();
    }
  });

  test("preserves a newer same-org credential a concurrent process writes mid-exchange", async () => {
    let tokenRequestCount = 0;
    const provider = startMockProvider(async (body) => {
      tokenRequestCount += 1;
      if (
        body.get("grant_type") !== "refresh_token" ||
        body.get("refresh_token") !== "old-refresh-token"
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      // Simulate a concurrent process (another command's own refresh
      // racing this one, or a fresh `auth login` to the same org)
      // finishing first and replacing this exact (serverUrl, orgId)
      // credential's tokens while this exchange is still in flight. Reads
      // the target back off disk rather than closing over `provider`.
      const concurrent = await readCredentialFile(configDir);
      const target = concurrent.credentials.at(0);
      if (target === undefined) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      await writeCredentialFile(
        configDir,
        upsertCredential(concurrent, {
          ...target,
          accessToken: "concurrent-access-token",
          expiresAt: Date.now() + 60_000,
          refreshToken: "concurrent-refresh-token",
          updatedAt: Date.now(),
        }),
      );
      // The stale-generation exchange still "succeeds" at the network
      // level — the token endpoint has no way to know a newer credential
      // already landed locally.
      return Response.json({
        access_token: "stale-generation-token",
        expires_in: 900,
        refresh_token: "stale-generation-refresh-token",
        scope: "openid stella:read",
        token_type: "Bearer",
      });
    });
    try {
      const now = Date.now();
      await seedCredential(
        buildCredential(provider.serverUrl, { expiresAt: now - 1000 }),
      );

      const result = await resolveAccessToken({
        configDir,
        serverUrl: provider.serverUrl,
        now,
      });

      // The concurrent write already landed a newer, comfortably-valid
      // credential; this command must use that one rather than the token
      // from its own (now-stale) exchange.
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.token).toBe("concurrent-access-token");
      }
      expect(tokenRequestCount).toBe(1);

      // The newer credential must survive on disk untouched — not rolled
      // back to the stale-generation tokens this exchange produced.
      const persisted = await readCredentialFile(configDir);
      const stored = persisted.credentials.find(
        (credential) =>
          credential.serverUrl === provider.serverUrl &&
          credential.orgId === "org-1",
      );
      expect(stored?.accessToken).toBe("concurrent-access-token");
      expect(stored?.refreshToken).toBe("concurrent-refresh-token");
    } finally {
      provider.close();
    }
  });
});
