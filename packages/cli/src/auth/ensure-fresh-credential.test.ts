import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readCredentialFile, upsertCredential } from "./credential-store.js";
import type { CredentialFile, StoredCredential } from "./credential-store.js";
import { ensureFreshCredential } from "./ensure-fresh-credential.js";
import type { AuthorizationServerMetadata } from "./oauth-metadata.js";

const buildCredential = (
  overrides: Partial<StoredCredential> = {},
): StoredCredential => ({
  accessToken: "old-access-token",
  clientId: "client-id",
  createdAt: 0,
  expiresAt: 10_000,
  orgId: "org-1",
  refreshToken: "old-refresh-token",
  scope: "openid stella:read",
  serverUrl: "https://stella.example",
  tokenType: "Bearer",
  updatedAt: 0,
  ...overrides,
});

/** A mock `/oauth2/token` endpoint whose response depends on the test scenario, plus a request counter. */
const startMockProvider = (
  handleTokenRequest: (body: URLSearchParams) => Response,
) => {
  let requestCount = 0;
  const server = Bun.serve({
    fetch: async (request) => {
      requestCount += 1;
      const body = new URLSearchParams(await request.text());
      return handleTokenRequest(body);
    },
    hostname: "127.0.0.1",
    port: 0,
  });

  const metadata: AuthorizationServerMetadata = {
    authorization_endpoint: `http://127.0.0.1:${server.port}/oauth2/authorize`,
    issuer: `http://127.0.0.1:${server.port}`,
    token_endpoint: `http://127.0.0.1:${server.port}/oauth2/token`,
  };

  return {
    close: () => {
      void server.stop(true);
    },
    getRequestCount: () => requestCount,
    metadata,
  };
};

describe("ensureFreshCredential", () => {
  let configDir: string;
  let credentialFile: CredentialFile;

  beforeEach(async () => {
    configDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-cli-refresh-test-"),
    );
    credentialFile = { credentials: [], defaultOrgByServer: {}, version: 1 };
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  test("returns the credential unchanged (no network call) when it is not near expiry", async () => {
    const provider = startMockProvider(
      () => new Response("should not be called", { status: 500 }),
    );
    try {
      const credential = buildCredential({ expiresAt: Date.now() + 60_000 });
      const result = await ensureFreshCredential({
        configDir,
        credential,
        credentialFile,
        metadata: provider.metadata,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.value).toEqual(credential);
      }
      expect(provider.getRequestCount()).toBe(0);
    } finally {
      provider.close();
    }
  });

  test("refreshes and persists an expired credential when a refresh token is available", async () => {
    const provider = startMockProvider(
      (body) =>
        new Response(
          JSON.stringify(
            body.get("grant_type") === "refresh_token" &&
              body.get("refresh_token") === "old-refresh-token"
              ? {
                  access_token: "new-access-token",
                  expires_in: 900,
                  refresh_token: "new-refresh-token",
                  scope: "openid stella:read",
                  token_type: "Bearer",
                }
              : { error: "invalid_grant" },
          ),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        ),
    );

    try {
      const credential = buildCredential({ expiresAt: Date.now() - 1000 });
      const now = Date.now();
      const result = await ensureFreshCredential({
        configDir,
        credential,
        credentialFile: upsertCredential(credentialFile, credential),
        metadata: provider.metadata,
        now,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.value.accessToken).toBe("new-access-token");
        expect(result.value.refreshToken).toBe("new-refresh-token");
        expect(result.value.expiresAt).toBe(now + 900 * 1000);
      }
      expect(provider.getRequestCount()).toBe(1);

      const persisted = await readCredentialFile(configDir);
      expect(persisted.credentials.at(0)?.accessToken).toBe("new-access-token");
    } finally {
      provider.close();
    }
  });

  test("surfaces a refresh failure from the provider as an error", async () => {
    const provider = startMockProvider(
      () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          headers: { "Content-Type": "application/json" },
          status: 400,
        }),
    );

    try {
      const credential = buildCredential({ expiresAt: Date.now() - 1000 });
      const result = await ensureFreshCredential({
        configDir,
        credential,
        credentialFile: upsertCredential(credentialFile, credential),
        metadata: provider.metadata,
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error._tag).toBe("TokenRefreshError");
      }
      expect(provider.getRequestCount()).toBe(1);
    } finally {
      provider.close();
    }
  });

  test("errors without a network call when the credential is expired and has no refresh token", async () => {
    const provider = startMockProvider(
      () => new Response("should not be called", { status: 500 }),
    );
    try {
      const credential = buildCredential({
        expiresAt: Date.now() - 1000,
        refreshToken: undefined,
      });
      const result = await ensureFreshCredential({
        configDir,
        credential,
        credentialFile: upsertCredential(credentialFile, credential),
        metadata: provider.metadata,
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error._tag).toBe("NoRefreshTokenError");
      }
      expect(provider.getRequestCount()).toBe(0);
    } finally {
      provider.close();
    }
  });
});
