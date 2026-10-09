import { APIError } from "better-auth/api";
import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
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
  const transport = await import("@better-auth/cimd/node");
  const originalFetch = transport.fetchClientMetadataResource;
  const documents = new Map<string, unknown>();
  await mock.module("@better-auth/cimd/node", () => ({
    ...transport,
    fetchClientMetadataResource: async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      const document = documents.get(url);
      if (document === undefined) {
        return await originalFetch(input, init);
      }
      return new Response(JSON.stringify(document), {
        headers: { "content-type": "application/json" },
      });
    },
  }));
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

  const fixture = async (
    clientKind: "registered" | "metadata" = "registered",
  ) => {
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
    const client =
      clientKind === "registered"
        ? await registerOAuthClient(undefined, "none")
        : { clientId: `https://client.example.com/${Bun.randomUUIDv7()}.json` };
    if (clientKind === "metadata") {
      documents.set(client.clientId, {
        client_id: client.clientId,
        client_name: "Refresh scope",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: ["https://connector.example.test/oauth/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    }
    cleanup.push(
      async () =>
        await rootDb
          .delete(oauthClient)
          .where(eq(oauthClient.clientId, client.clientId)),
    );
    const grant = await grantOAuthClient(browser, client);
    return { browser, client, grant };
  };

  describe("OAuth refresh scope policy (postgres)", () => {
    for (const clientKind of ["registered", "metadata"] as const) {
      for (const requestScopes of ["omitted", "authorized"] as const) {
        test(`rejects ${clientKind} resource-only grants with ${requestScopes} request scopes repeatedly`, async () => {
          const { client, grant } = await fixture(clientKind);
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
          const address = `198.51.100.${String(attempt + 1)}`;
          const response = await auth.handler(
            new Request(getAuthEndpointUrl("oauth2/token"), {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                "x-forwarded-for": address,
                [AUTH_CLIENT_ADDRESS_HEADER]: address,
              },
              body: new URLSearchParams({
                client_id: client.clientId,
                grant_type: "refresh_token",
                refresh_token: grant.refreshToken,
                resource,
              }),
            }),
          );
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({
            error: "invalid_grant",
          });
        }
      });
    }

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
