import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { oauthAccessToken, oauthRefreshToken } from "@/api/db/auth-schema";
import { createHumanSession } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  grantOAuthClient,
  refreshOAuthGrant,
  registerOAuthClient,
  revokeOAuthToken,
} from "@/api/tests/helpers/oauth-grant";
import type { RegisteredOAuthClient } from "@/api/tests/helpers/oauth-grant";

// The provider's refresh and revocation contract, through its HTTP endpoints:
// revocation ends a grant together with every rotation of it, an unknown
// token is answered as revoked (RFC 7009 §2.2), and a grant refreshed with a
// reduced scope stays refreshable.

beforeAll(async () => {
  await initAgentAuthTestDb();
});
afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const tokensSchema = v.looseObject({
  refresh_token: v.pipe(v.string(), v.nonEmpty()),
  scope: v.string(),
});

const fixture = async () => {
  const { browser } = await createHumanSession({
    email: `refresh-revocation-${Bun.randomUUIDv7()}@example.test`,
    orgName: "Refresh revocation",
    orgSlugPrefix: "refresh-revocation",
  });
  const client = await registerOAuthClient(undefined, "none");
  const grant = await grantOAuthClient(browser, client);
  expect(grant.scope.split(" ")).toContain("offline_access");
  return { browser, client, grant, userId: browser.userId };
};

const rotate = async (client: RegisteredOAuthClient, refreshToken: string) => {
  const response = await refreshOAuthGrant({ client, refreshToken });
  expect(response.status).toBe(200);
  return v.parse(tokensSchema, await response.json()).refresh_token;
};

const countTokenRows = async (clientId: string, userId: string) => {
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

describe("OAuth refresh token revocation", () => {
  test("revoking the current refresh token removes its rotation records", async () => {
    const { client, grant, userId } = await fixture();
    const current = await rotate(client, grant.refreshToken);

    const revoked = await revokeOAuthToken({
      client,
      token: current,
      tokenTypeHint: "refresh_token",
    });
    expect(revoked.status).toBe(200);
    expect(await countTokenRows(client.clientId, userId)).toEqual({
      refresh: 0,
      access: 0,
    });

    // Presented straight after the rotation, the previous token would be
    // answered from the rotation records; after revocation it is refused.
    const previous = await refreshOAuthGrant({
      client,
      refreshToken: grant.refreshToken,
    });
    expect(previous.status).toBe(400);
    expect(await previous.json()).toMatchObject({ error: "invalid_grant" });
    const successor = await refreshOAuthGrant({
      client,
      refreshToken: current,
    });
    expect(successor.status).toBe(400);
  });

  test.each(["refresh_token", "access_token", "none"] as const)(
    "revoking an unknown token with type hint %s succeeds and leaves the grant active",
    async (tokenTypeHint) => {
      const { client, grant } = await fixture();
      const revoked = await revokeOAuthToken({
        client,
        token: Bun.randomUUIDv7().replaceAll("-", ""),
        tokenTypeHint,
      });
      expect(revoked.status).toBe(200);
      expect(
        (await refreshOAuthGrant({ client, refreshToken: grant.refreshToken }))
          .status,
      ).toBe(200);
    },
  );

  test("a refresh token issued to another client is neither revoked nor refreshed by it", async () => {
    const { client, grant } = await fixture();
    const other = await registerOAuthClient(undefined, "none");
    const revoked = await revokeOAuthToken({
      client: other,
      token: grant.refreshToken,
      tokenTypeHint: "refresh_token",
    });
    expect(revoked.status).toBe(200);
    const foreign = await refreshOAuthGrant({
      client: other,
      refreshToken: grant.refreshToken,
    });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ error: "invalid_grant" });
    expect(
      (await refreshOAuthGrant({ client, refreshToken: grant.refreshToken }))
        .status,
    ).toBe(200);
  });
});

describe("OAuth revocation by another client", () => {
  test.each(["current", "rotated"] as const)(
    "another client presenting the owner's %s tokens changes neither client's grant",
    async (state) => {
      const { browser, client, grant, userId } = await fixture();
      const rotated = await rotate(client, grant.refreshToken);
      const presented = state === "current" ? rotated : grant.refreshToken;
      const other = await registerOAuthClient(undefined, "none");
      const otherGrant = await grantOAuthClient(browser, other);
      const ownerRows = await countTokenRows(client.clientId, userId);
      const otherRows = await countTokenRows(other.clientId, userId);
      expect(ownerRows.refresh).toBe(2);

      for (const [token, tokenTypeHint] of [
        [presented, "refresh_token"],
        [presented, "none"],
        [grant.accessToken, "access_token"],
      ] as const) {
        const revoked = await revokeOAuthToken({
          client: other,
          token,
          tokenTypeHint,
        });
        expect(revoked.status).toBeLessThan(500);
      }

      expect(await countTokenRows(client.clientId, userId)).toEqual(ownerRows);
      expect(await countTokenRows(other.clientId, userId)).toEqual(otherRows);
      expect(
        (await refreshOAuthGrant({ client, refreshToken: rotated })).status,
      ).toBe(200);
      expect(
        (
          await refreshOAuthGrant({
            client: other,
            refreshToken: otherGrant.refreshToken,
          })
        ).status,
      ).toBe(200);
    },
  );

  test("the owner revoking its token ends its family and leaves another client's grant", async () => {
    const { browser, client, grant, userId } = await fixture();
    const rotated = await rotate(client, grant.refreshToken);
    const other = await registerOAuthClient(undefined, "none");
    const otherGrant = await grantOAuthClient(browser, other);
    const otherRows = await countTokenRows(other.clientId, userId);

    const revoked = await revokeOAuthToken({
      client,
      token: rotated,
      tokenTypeHint: "refresh_token",
    });
    expect(revoked.status).toBe(200);
    expect(await countTokenRows(client.clientId, userId)).toEqual({
      refresh: 0,
      access: 0,
    });
    expect(await countTokenRows(other.clientId, userId)).toEqual(otherRows);
    expect(
      (
        await refreshOAuthGrant({
          client: other,
          refreshToken: otherGrant.refreshToken,
        })
      ).status,
    ).toBe(200);
  });
});

describe("OAuth reduced-scope refresh", () => {
  test("a grant refreshed with a reduced scope stays refreshable", async () => {
    const { client, grant } = await fixture();
    let refreshToken = grant.refreshToken;
    for (let rotation = 0; rotation < 3; rotation += 1) {
      const response = await refreshOAuthGrant({
        client,
        refreshToken,
        scope: "stella:read",
      });
      expect(response.status).toBe(200);
      const successor = v.parse(tokensSchema, await response.json());
      expect(successor.scope).toBe("stella:read");
      expect(successor.refresh_token).not.toBe(refreshToken);
      refreshToken = successor.refresh_token;
    }
  });
});
