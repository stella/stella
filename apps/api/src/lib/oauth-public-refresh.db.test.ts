import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq, isNotNull } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

const DOCUMENT_URL = "https://client.example.com/oauth/refresh-client.json";
const REDIRECT_URI = "https://connector.example.test/oauth/callback";

await mock.module("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: () =>
    Response.json({
      client_id: DOCUMENT_URL,
      client_name: "Public refresh client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
}));

const { getAuth } = await import("@/api/lib/auth");
const { getAuthEndpointUrl, getAuthIssuerUrl } =
  await import("@/api/lib/auth/auth-paths");
const { oauthRefreshToken, oauthAccessToken } =
  await import("@/api/db/auth-schema");
const { rootDb } = await import("@/api/db/root");
const { getMcpResourceUrl, MCP_MODES } = await import("@/api/mcp/constants");
const { getMcpAccessTokenVerificationOptions } = await import("@/api/mcp/auth");
const { createHumanSession } =
  await import("@/api/tests/helpers/human-session");
const { grantOAuthClient, refreshOAuthGrant, registerOAuthClient } =
  await import("@/api/tests/helpers/oauth-grant");
const { initAgentAuthTestDb, releaseAgentAuthTestDb } =
  await import("@/api/tests/helpers/mock-agent-auth-db");

beforeAll(async () => {
  await initAgentAuthTestDb();
});
afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const tokensSchema = v.looseObject({
  access_token: v.pipe(v.string(), v.nonEmpty()),
  refresh_token: v.pipe(v.string(), v.nonEmpty()),
  scope: v.string(),
});

const fixture = async (
  registration: "dynamic" | "metadata" | "confidential",
) => {
  const { browser } = await createHumanSession({
    email: `public-refresh-${Bun.randomUUIDv7()}@example.test`,
    orgName: "Public refresh",
    orgSlugPrefix: "public-refresh",
  });
  const registeredAt = performance.now();
  const client =
    registration !== "metadata"
      ? await registerOAuthClient(
          undefined,
          registration === "confidential" ? "client_secret_post" : "none",
        )
      : { clientId: DOCUMENT_URL };
  expect(performance.now() - registeredAt).toBeLessThan(10_000);
  const start = performance.now();
  const grant = await grantOAuthClient(browser, client);
  expect(performance.now() - start).toBeLessThan(10_000);
  expect(grant.scope.split(" ")).toContain("offline_access");
  return { client, grant, userId: browser.userId };
};

const countTokenRows = async ({
  clientId,
  userId,
}: {
  clientId: string;
  userId: string;
}) => {
  const database = await initAgentAuthTestDb();
  return {
    refresh: await database.$count(
      oauthRefreshToken,
      and(
        eq(oauthRefreshToken.clientId, clientId),
        eq(oauthRefreshToken.userId, userId),
      ),
    ),
    access: await database.$count(
      oauthAccessToken,
      and(
        eq(oauthAccessToken.clientId, clientId),
        eq(oauthAccessToken.userId, userId),
      ),
    ),
  };
};

describe("resource-bound refresh grants", () => {
  test.each([
    ["dynamic", 1],
    ["dynamic", 2],
    ["metadata", 1],
    ["metadata", 2],
    ["confidential", 1],
    ["confidential", 2],
  ] as const)(
    "rotates %s grants %s times and replays each response identically within the window",
    async (registration, rotations) => {
      const { client, grant, userId } = await fixture(registration);
      let refreshToken = grant.refreshToken;
      for (let round = 0; round < rotations; round += 1) {
        const start = performance.now();
        const response = await refreshOAuthGrant({ client, refreshToken });
        expect(performance.now() - start).toBeLessThan(10_000);
        expect(response.status).toBe(200);
        const tokens = v.parse(tokensSchema, await response.json());
        expect(tokens.refresh_token).not.toBe(refreshToken);
        expect(tokens.scope.split(" ")).toContain("offline_access");
        const rowsBefore = await countTokenRows({
          clientId: client.clientId,
          userId,
        });
        const replay = await refreshOAuthGrant({ client, refreshToken });
        expect(replay.status).toBe(200);
        const replayTokens = v.parse(tokensSchema, await replay.json());
        expect(replayTokens.access_token === tokens.access_token).toBe(true);
        expect(replayTokens.refresh_token === tokens.refresh_token).toBe(true);
        expect(
          await countTokenRows({ clientId: client.clientId, userId }),
        ).toEqual(rowsBefore);
        refreshToken = tokens.refresh_token;
      }
      const stored = await rootDb
        .select()
        .from(oauthRefreshToken)
        .where(
          and(
            eq(oauthRefreshToken.clientId, client.clientId),
            eq(oauthRefreshToken.userId, userId),
          ),
        );
      expect(stored.filter((row) => row.rotatedAt !== null)).toHaveLength(
        rotations,
      );
      for (const rotated of stored.filter((row) => row.rotatedAt !== null)) {
        expect(rotated.rotationReplayExpiresAt).not.toBeNull();
        expect(rotated.rotationReplayResponse).not.toBeNull();
      }
    },
  );

  test.each(["dynamic", "metadata", "confidential"] as const)(
    "expires the %s replay window and ends the whole refresh family",
    async (registration) => {
      const { client, grant, userId } = await fixture(registration);
      const rotation = await refreshOAuthGrant({
        client,
        refreshToken: grant.refreshToken,
      });
      expect(rotation.status).toBe(200);
      const successor = v.parse(tokensSchema, await rotation.json());
      await rootDb
        .update(oauthRefreshToken)
        .set({ rotationReplayExpiresAt: new Date(0) })
        .where(
          and(
            eq(oauthRefreshToken.clientId, client.clientId),
            eq(oauthRefreshToken.userId, userId),
            isNotNull(oauthRefreshToken.rotatedAt),
          ),
        );
      for (const refreshToken of [
        grant.refreshToken,
        successor.refresh_token,
      ]) {
        const response = await refreshOAuthGrant({ client, refreshToken });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "invalid_grant" });
      }
      expect(
        await countTokenRows({ clientId: client.clientId, userId }),
      ).toEqual({
        refresh: 0,
        access: 0,
      });
    },
  );

  test.each(["dynamic", "metadata", "confidential"] as const)(
    "refuses to replay a %s grant for a different client",
    async (registration) => {
      const { client, grant, userId } = await fixture(registration);
      const rotation = await refreshOAuthGrant({
        client,
        refreshToken: grant.refreshToken,
      });
      expect(rotation.status).toBe(200);
      const successor = v.parse(tokensSchema, await rotation.json());
      const otherClient = await registerOAuthClient(undefined, "none");
      const rowsBefore = await countTokenRows({
        clientId: client.clientId,
        userId,
      });
      const response = await refreshOAuthGrant({
        client: otherClient,
        refreshToken: grant.refreshToken,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
      expect(
        await countTokenRows({ clientId: client.clientId, userId }),
      ).toEqual(rowsBefore);
      const valid = await refreshOAuthGrant({
        client,
        refreshToken: successor.refresh_token,
      });
      expect(valid.status).toBe(200);
    },
  );

  test.each(["unknown", "expired", "revoked"] as const)(
    "answers invalid_grant for a %s refresh token",
    async (state) => {
      const { client, grant } = await fixture("dynamic");
      switch (state) {
        case "unknown":
          break;
        case "expired":
          await rootDb
            .update(oauthRefreshToken)
            .set({ expiresAt: new Date(0) })
            .where(eq(oauthRefreshToken.clientId, client.clientId));
          break;
        case "revoked":
          await rootDb
            .update(oauthRefreshToken)
            .set({ revoked: new Date() })
            .where(eq(oauthRefreshToken.clientId, client.clientId));
          break;
        default: {
          const exhaustive: never = state;
          return exhaustive;
        }
      }
      const response = await refreshOAuthGrant({
        client,
        refreshToken:
          state === "unknown" ? "unknown-refresh-token" : grant.refreshToken,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    },
  );

  test("accepts form grants with a resource and binds the signed audience to that resource", async () => {
    const { client, grant } = await fixture("dynamic");
    const response = await getAuth().handler(
      new Request(getAuthEndpointUrl("jwks")),
    );
    expect(response.status).toBe(200);
    const keys = createLocalJWKSet(
      v.parse(
        v.object({ keys: v.array(v.looseObject({ kty: v.string() })) }),
        await response.json(),
      ),
    );
    const refreshed = await refreshOAuthGrant({
      client,
      refreshToken: grant.refreshToken,
    });
    expect(refreshed.status).toBe(200);
    const successor = v.parse(tokensSchema, await refreshed.json());
    for (const accessToken of [grant.accessToken, successor.access_token]) {
      const accepted = await jwtVerify(accessToken, keys, {
        issuer: getAuthIssuerUrl(),
        audience: getMcpResourceUrl(),
      });
      expect(accepted.payload.aud).toBe(getMcpResourceUrl());
      for (const mode of MCP_MODES) {
        const { verifyOptions } = getMcpAccessTokenVerificationOptions(mode);
        if (mode === "default") {
          expect(
            await jwtVerify(accessToken, keys, verifyOptions),
          ).toMatchObject({ payload: { aud: getMcpResourceUrl() } });
          continue;
        }
        expect(
          await rejectionOf(jwtVerify(accessToken, keys, verifyOptions)),
        ).toMatchObject({
          code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
          claim: "aud",
        });
      }
    }
  });
});
