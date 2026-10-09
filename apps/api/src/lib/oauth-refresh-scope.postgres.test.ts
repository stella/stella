import { APIError } from "better-auth/api";
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
  oauthClientResource,
  oauthRefreshToken,
  oauthResource,
  organization,
  user,
} from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { describeAuthRefusal } from "@/api/lib/auth/auth-refusal-log";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";

const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const tokenSchema = v.object({
  access_token: v.string(),
  refresh_token: v.string(),
});
setDefaultTimeout(120_000);

if (!runPostgres || !process.env["DATABASE_URL"]) {
  describe.skip("OAuth refresh scope policy (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {});
  });
} else {
  const { getAuth } = await import("@/api/lib/auth");
  const { signInHuman } = await import("@/api/tests/helpers/human-session");
  const { grantOAuthClient, refreshOAuthGrant, registerOAuthClient } =
    await import("@/api/tests/helpers/oauth-grant");
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
    expect(provider.options.refreshTokenReuseInterval).toBe(30);
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
      `refresh-scope-${Bun.randomUUIDv7()}@example.test`,
    );
    cleanup.push(
      async () => await rootDb.delete(user).where(eq(user.id, browser.userId)),
    );
    const firm = await auth.api.createOrganization({
      body: {
        name: "Refresh scope",
        slug: `refresh-scope-${Bun.randomUUIDv7()}`,
      },
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

  type ResourceRefreshOptions = Parameters<typeof refreshOAuthGrant>[0] & {
    resource: string;
  };
  let resourceRequests = 0;
  const refreshResourceGrant = async ({
    client,
    refreshToken,
    scope,
    resource,
  }: ResourceRefreshOptions) => {
    resourceRequests += 1;
    const address = `203.0.113.${String(resourceRequests)}`;
    return await auth.handler(
      new Request(getAuthEndpointUrl("oauth2/token"), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": address,
          [AUTH_CLIENT_ADDRESS_HEADER]: address,
        },
        body: new URLSearchParams({
          client_id: client.clientId,
          ...(client.clientSecret === undefined
            ? {}
            : { client_secret: client.clientSecret }),
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          resource,
          ...(scope === undefined ? {} : { scope }),
        }),
      }),
    );
  };

  describe("OAuth refresh scope policy (postgres)", () => {
    for (const requestScopes of ["omitted", "authorized"] as const) {
      test(`rejects registered resource-only grants with ${requestScopes} request scopes repeatedly`, async () => {
        const { client, grant } = await fixture();
        const scopes = grant.scope
          .split(" ")
          .filter((scope) => scope.startsWith("stella:"));
        expect(grant.scope.split(" ")).toContain("offline_access");
        expect(scopes.length).toBeGreaterThan(0);
        expect(scopes).not.toContain("offline_access");
        const changed = await rootDb
          .update(oauthRefreshToken)
          .set({ scopes })
          .where(eq(oauthRefreshToken.clientId, client.clientId))
          .returning({
            scopes: oauthRefreshToken.scopes,
            rotatedAt: oauthRefreshToken.rotatedAt,
          });
        expect(changed).toEqual([{ scopes, rotatedAt: null }]);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await refreshOAuthGrant({
            client,
            refreshToken: grant.refreshToken,
            ...(requestScopes === "authorized" ? { scope: grant.scope } : {}),
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({
            error: "invalid_grant",
          });
        }
      });
    }

    for (const allowedScopes of [["unavailable:read"], ["stella:read"]]) {
      test(`rejects stored grants under resource policy ${allowedScopes.join(" ")}`, async () => {
        const { client, grant } = await fixture();
        const resource = `https://resource.example.test/${Bun.randomUUIDv7()}`;
        await rootDb.insert(oauthResource).values({
          id: Bun.randomUUIDv7(),
          identifier: resource,
          name: "Refresh scope",
          allowedScopes,
        });
        cleanup.push(
          async () =>
            await rootDb
              .delete(oauthResource)
              .where(eq(oauthResource.identifier, resource)),
        );
        await rootDb.insert(oauthClientResource).values({
          id: Bun.randomUUIDv7(),
          clientId: client.clientId,
          resourceId: resource,
        });
        const changed = await rootDb
          .update(oauthRefreshToken)
          .set({ resources: [resource] })
          .where(eq(oauthRefreshToken.clientId, client.clientId))
          .returning({ resources: oauthRefreshToken.resources });
        expect(changed).toEqual([{ resources: [resource] }]);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await refreshResourceGrant({
            client,
            refreshToken: grant.refreshToken,
            resource,
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({
            error: "invalid_grant",
          });
        }
      });
    }

    test("refuses a scope reduction outside resource policy and rotates an allowed retry", async () => {
      const { client, grant } = await fixture();
      expect(grant.scope.split(" ")).toContain("stella:templates");
      const resource = `https://resource.example.test/${Bun.randomUUIDv7()}`;
      await rootDb.insert(oauthResource).values({
        id: Bun.randomUUIDv7(),
        identifier: resource,
        name: "Refresh scope",
        allowedScopes: ["offline_access", "stella:read"],
      });
      cleanup.push(
        async () =>
          await rootDb
            .delete(oauthResource)
            .where(eq(oauthResource.identifier, resource)),
      );
      await rootDb.insert(oauthClientResource).values({
        id: Bun.randomUUIDv7(),
        clientId: client.clientId,
        resourceId: resource,
      });
      const scopes = ["offline_access", "stella:read", "stella:templates"];
      const changed = await rootDb
        .update(oauthRefreshToken)
        .set({ scopes, resources: [resource] })
        .where(eq(oauthRefreshToken.clientId, client.clientId))
        .returning({ scopes: oauthRefreshToken.scopes });
      expect(changed).toEqual([{ scopes }]);
      const refused = await refreshResourceGrant({
        client,
        refreshToken: grant.refreshToken,
        resource,
        scope: "stella:templates",
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid_scope" });
      const accepted = await refreshResourceGrant({
        client,
        refreshToken: grant.refreshToken,
        resource,
        scope: "stella:read",
      });
      expect(accepted.status).toBe(200);
      const successor = v.parse(tokenSchema, await accepted.json());
      expect(successor.refresh_token === grant.refreshToken).toBe(false);
      expect(
        (
          await refreshResourceGrant({
            client,
            refreshToken: successor.refresh_token,
            resource,
            scope: "stella:read",
          })
        ).status,
      ).toBe(200);
    });

    test("rotates three successive grants and replays each previous response", async () => {
      const { client, grant } = await fixture();
      const stored = await rootDb.query.oauthRefreshToken.findFirst({
        where: { clientId: client.clientId },
        columns: { scopes: true },
      });
      expect(stored?.scopes).toContain("offline_access");
      let refreshToken = grant.refreshToken;
      for (let rotation = 0; rotation < 3; rotation += 1) {
        const response = await refreshOAuthGrant({ client, refreshToken });
        expect(response.status).toBe(200);
        const successor = v.parse(tokenSchema, await response.json());
        expect(successor.refresh_token === refreshToken).toBe(false);
        const replay = await refreshOAuthGrant({ client, refreshToken });
        expect(replay.status).toBe(200);
        expect(v.parse(tokenSchema, await replay.json())).toEqual(successor);
        refreshToken = successor.refresh_token;
      }
    });

    test("refuses requested scope expansion and accepts a retry without it", async () => {
      const { client, grant } = await fixture();
      const response = await refreshOAuthGrant({
        client,
        refreshToken: grant.refreshToken,
        scope: `${grant.scope} ungranted:read`,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_scope" });
      expect(
        (await refreshOAuthGrant({ client, refreshToken: grant.refreshToken }))
          .status,
      ).toBe(200);
    });

    test("keeps reduced grants refreshable across rotations", async () => {
      const { client, grant } = await fixture();
      let refreshToken = grant.refreshToken;
      for (let rotation = 0; rotation < 3; rotation += 1) {
        const response = await refreshOAuthGrant({
          client,
          refreshToken,
          scope: "stella:read",
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ scope: "stella:read" });
        const successor = v.parse(tokenSchema, body);
        expect(successor.refresh_token === refreshToken).toBe(false);
        refreshToken = successor.refresh_token;
      }
    });

    test("classifies invalid grants for the auth refusal log", () => {
      expect(
        describeAuthRefusal({
          path: "/oauth2/token",
          returned: new APIError("BAD_REQUEST", { error: "invalid_grant" }),
          body: { grant_type: "refresh_token" },
        }),
      ).toEqual({
        type: "refused",
        attributes: {
          "auth.path": "/oauth2/token",
          "http.status_code": 400,
          "auth.error_code": "invalid_grant",
          "oauth.grant_type": "refresh_token",
        },
      });
    });
  });
}
