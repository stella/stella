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

import { oauthRefreshToken } from "@/api/db/auth-schema";

// Refresh scope policy for Client ID Metadata Document clients. The auth
// instance captures the CIMD transport when it is built, so the transport is
// replaced before anything imports auth, in a file that owns its process.

setDefaultTimeout(120_000);

const documents = new Map<string, unknown>();

await mock.module("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const document = documents.get(url);
    if (document === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(document), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  },
}));

const { getAuth } = await import("@/api/lib/auth");
const { signInHuman } = await import("@/api/tests/helpers/human-session");
const { initAgentAuthTestDb, releaseAgentAuthTestDb } =
  await import("@/api/tests/helpers/mock-agent-auth-db");
const { grantOAuthClient, refreshOAuthGrant } =
  await import("@/api/tests/helpers/oauth-grant");

let testDb: Awaited<ReturnType<typeof initAgentAuthTestDb>>;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const fixture = async () => {
  const browser = await signInHuman(
    `refresh-scope-${Bun.randomUUIDv7()}@example.test`,
  );
  const firm = await getAuth().api.createOrganization({
    body: {
      name: "Refresh scope",
      slug: `refresh-scope-${Bun.randomUUIDv7()}`,
    },
    headers: browser.headers(),
  });
  await browser.setActiveOrganization(firm.id);
  const client = {
    clientId: `https://client.example.com/${Bun.randomUUIDv7()}.json`,
  };
  documents.set(client.clientId, {
    client_id: client.clientId,
    client_name: "Refresh scope",
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: ["https://connector.example.test/oauth/callback"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  const grant = await grantOAuthClient(browser, client);
  return { client, grant };
};

describe("OAuth refresh scope policy for metadata clients", () => {
  test.each(["omitted", "authorized"] as const)(
    "rejects metadata resource-only grants with %s request scopes repeatedly",
    async (requestScopes) => {
      const { client, grant } = await fixture();
      const scopes = grant.scope
        .split(" ")
        .filter((scope) => scope.startsWith("stella:"));
      expect(grant.scope.split(" ")).toContain("offline_access");
      expect(scopes.length).toBeGreaterThan(0);
      expect(scopes).not.toContain("offline_access");
      const changed = await testDb
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
    },
  );
});
