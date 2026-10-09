import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import {
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  organization,
  user,
} from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { meRoute } from "@/api/handlers/me/routes";
import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  authorizeOAuthClient,
  exchangeOAuthCode,
  grantOAuthClient,
  refreshOAuthGrant,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";

const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const tokenSchema = v.looseObject({
  access_token: v.string(),
  refresh_token: v.string(),
});
setDefaultTimeout(120_000);

if (!runPostgres || !process.env["DATABASE_URL"]) {
  describe.skip("OAuth refresh revocation (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {});
  });
} else {
  const auth = getAuth();
  const context = await auth.$context;
  const provider =
    context.getPlugin("oauth-provider") ?? panic("OAuth provider required");

  const cleanup: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const remove of cleanup.toReversed()) {
      await remove();
    }
  });
  beforeAll(async () => {
    expect(provider.version).toBe("1.7.6");
    await rootDb
      .insert(oauthResource)
      .values(
        getBetterAuthOAuthResources().map((resource) => ({
          id: Bun.randomUUIDv7(),
          ...resource,
        })),
      )
      .onConflictDoNothing();
  });
  const fixture = async () => {
    const browser = await signInHuman(
      `rotation-${Bun.randomUUIDv7()}@example.test`,
    );
    cleanup.push(
      async () => await rootDb.delete(user).where(eq(user.id, browser.userId)),
    );
    const firm = await auth.api.createOrganization({
      body: { name: "Rotation", slug: `rotation-${Bun.randomUUIDv7()}` },
      headers: browser.headers(),
    });
    cleanup.push(
      async () =>
        await rootDb.delete(organization).where(eq(organization.id, firm.id)),
    );
    await browser.setActiveOrganization(firm.id);
    const client = await registerOAuthClient(undefined, "none");
    cleanup.push(
      async () =>
        await rootDb
          .delete(oauthClient)
          .where(eq(oauthClient.clientId, client.clientId)),
    );
    const grant = await grantOAuthClient(browser, client);
    return { browser, client, grant };
  };

  const countRefreshRows = async (clientId: string) =>
    await rootDb.$count(
      oauthRefreshToken,
      eq(oauthRefreshToken.clientId, clientId),
    );

  let revocationRequests = 0;
  const revoke = async (clientId: string, token: string) => {
    revocationRequests += 1;
    const address = `198.51.110.${String(revocationRequests)}`;
    return await auth.handler(
      new Request(getAuthEndpointUrl("oauth2/revoke"), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": address,
          [AUTH_CLIENT_ADDRESS_HEADER]: address,
        },
        body: new URLSearchParams({
          client_id: clientId,
          token,
          token_type_hint: "refresh_token",
        }),
      }),
    );
  };

  describe("public-client refresh revocation (postgres)", () => {
    test("preserves client authentication errors for invalid tokens", async () => {
      const response = await revoke(
        Bun.randomUUIDv7(),
        "invalid refresh token!",
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_client" });
    });

    test.each(["current", "rotated"] as const)(
      "preserves client ownership when presented another client's %s token",
      async (state) => {
        const { browser, client, grant } = await fixture();
        let liveToken = grant.refreshToken;
        if (state === "rotated") {
          const rotated = await refreshOAuthGrant({
            client,
            refreshToken: liveToken,
          });
          expect(rotated.status).toBe(200);
          liveToken = v.parse(tokenSchema, await rotated.json()).refresh_token;
        }
        const otherClient = await registerOAuthClient(undefined, "none");
        cleanup.push(
          async () =>
            await rootDb
              .delete(oauthClient)
              .where(eq(oauthClient.clientId, otherClient.clientId)),
        );
        const otherGrant = await grantOAuthClient(browser, otherClient);
        const revoked = await revoke(otherClient.clientId, grant.refreshToken);
        const own = await refreshOAuthGrant({
          client: otherClient,
          refreshToken: otherGrant.refreshToken,
        });
        const original = await refreshOAuthGrant({
          client,
          refreshToken: liveToken,
        });
        expect({
          revoke: revoked.status,
          own: own.status,
          original: original.status,
        }).toEqual({ revoke: 200, own: 200, original: 200 });
      },
    );

    test("ends a current refresh token and accepts repeated revocation", async () => {
      const { client, grant } = await fixture();
      expect(await countRefreshRows(client.clientId)).toBe(1);
      const revoked = await revoke(client.clientId, grant.refreshToken);
      const later = await refreshOAuthGrant({
        client,
        refreshToken: grant.refreshToken,
      });
      const repeated = await revoke(client.clientId, grant.refreshToken);
      expect({
        revoked: revoked.status,
        repeated: repeated.status,
        refresh: later.status,
      }).toEqual({
        revoked: 200,
        repeated: 200,
        refresh: 400,
      });
      expect(await later.json()).toMatchObject({ error: "invalid_grant" });
    });

    test.each(["unknown", "invalid"] as const)(
      "accepts an %s refresh token without changing an active grant",
      async (kind) => {
        const { client, grant } = await fixture();
        const token =
          kind === "unknown"
            ? Bun.randomUUIDv7().replaceAll("-", "")
            : "invalid refresh token!";
        const revoked = await revoke(client.clientId, token);
        const later = await refreshOAuthGrant({ client, refreshToken: token });
        const active = await refreshOAuthGrant({
          client,
          refreshToken: grant.refreshToken,
        });
        expect({
          revoked: revoked.status,
          refresh: later.status,
          active: active.status,
        }).toEqual({ revoked: 200, refresh: 400, active: 200 });
        expect(await countRefreshRows(client.clientId)).toBe(2);
      },
    );

    test("accepts revocation of a rotated refresh token", async () => {
      const { client, grant } = await fixture();
      const rotated = await refreshOAuthGrant({
        client,
        refreshToken: grant.refreshToken,
      });
      expect(rotated.status).toBe(200);
      const tokens = v.parse(tokenSchema, await rotated.json());
      expect(await countRefreshRows(client.clientId)).toBe(2);
      const revoked = await revoke(client.clientId, grant.refreshToken);
      const later = await refreshOAuthGrant({
        client,
        refreshToken: grant.refreshToken,
      });
      const successor = await refreshOAuthGrant({
        client,
        refreshToken: tokens.refresh_token,
      });
      expect({
        revoked: revoked.status,
        refresh: later.status,
        successor: successor.status,
      }).toEqual({ revoked: 200, refresh: 400, successor: 400 });
      expect(await countRefreshRows(client.clientId)).toBe(0);
    });

    test("disconnects every refresh authorization for the selected connection", async () => {
      const { browser, client, grant } = await fixture();
      const authorizationB = await authorizeOAuthClient(browser, client);
      const loginB = await exchangeOAuthCode({
        client,
        codeVerifier: authorizationB.codeVerifier,
        redirect: authorizationB.redirect,
      });
      const rotated = await refreshOAuthGrant({
        client,
        refreshToken: grant.refreshToken,
      });
      expect(rotated.status).toBe(200);
      const tokens = v.parse(tokenSchema, await rotated.json());
      expect(await countRefreshRows(client.clientId)).toBe(3);
      const keptClient = await registerOAuthClient();
      cleanup.push(
        async () =>
          await rootDb
            .delete(oauthClient)
            .where(eq(oauthClient.clientId, keptClient.clientId)),
      );
      const keptGrant = await grantOAuthClient(browser, keptClient);
      const consent = await rootDb
        .select()
        .from(oauthConsent)
        .where(eq(oauthConsent.clientId, client.clientId))
        .limit(1);
      const consentId =
        consent.at(0)?.id ?? panic("Connection consent required");
      const disconnected = await meRoute.handle(
        new Request(`http://localhost/me/oauth-connections/${consentId}`, {
          method: "DELETE",
          headers: { cookie: browser.cookieHeader() },
        }),
      );
      const rowsAfterDisconnect = await countRefreshRows(client.clientId);
      const statuses = [];
      for (const refreshToken of [
        grant.refreshToken,
        loginB.refreshToken,
        tokens.refresh_token,
      ]) {
        statuses.push(
          (await refreshOAuthGrant({ client, refreshToken })).status,
        );
      }
      const kept = await refreshOAuthGrant({
        client: keptClient,
        refreshToken: keptGrant.refreshToken,
      });
      expect({
        disconnect: disconnected.status,
        rows: rowsAfterDisconnect,
        refresh: statuses,
        kept: kept.status,
      }).toEqual({
        disconnect: 200,
        rows: 0,
        refresh: [400, 400, 400],
        kept: 200,
      });
    });
  });
}
