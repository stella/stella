import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session,
} from "@/api/db/auth-schema";
import { oauthGrantRevocations } from "@/api/db/schema";
import { meRoute } from "@/api/handlers/me/routes";
import { getAuth } from "@/api/lib/auth";
import {
  getAuthEndpointUrl,
  getAuthIssuerUrl,
} from "@/api/lib/auth/auth-paths";
import { toSafeId } from "@/api/lib/branded-types";
import { resetLogSinkForTesting } from "@/api/lib/observability/logger";
import { mintAgentRunToken } from "@/api/mcp/agent-run-token";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  authorizeOAuthClient,
  grantOAuthClient,
  isOAuthTokenActive,
  OAUTH_CONSENT_PAGE_PATH,
  refreshOAuthGrant,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";
import type {
  OAuthGrant,
  RegisteredOAuthClient,
} from "@/api/tests/helpers/oauth-grant";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const routeServer = serveRoutesForTest(meRoute);
afterAll(async () => {
  await routeServer.stop();
});

// Disconnecting a connected app from the settings page, through the real
// session-authenticated route, against grants minted by the real OAuth
// provider.

setDefaultTimeout(120_000);

let testDb: TestDatabase;
const passThroughFetch = globalThis.fetch;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

beforeEach(() => {
  const jwksUrl = getAuthEndpointUrl("jwks");
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(String(input), init);
        if (request.url === jwksUrl) {
          return await getAuth().handler(request);
        }
        return await passThroughFetch(input, init);
      },
      { preconnect: passThroughFetch.preconnect },
    ),
  );
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});
afterEach(() => {
  mock.restore();
  resetLogSinkForTesting();
});

const BASE = "http://localhost";

const connectionsSchema = v.looseObject({
  connections: v.array(
    v.looseObject({
      id: v.string(),
      clientId: v.string(),
      referenceId: v.nullable(v.string()),
    }),
  ),
});

const listConnections = async (browser: HumanBrowser) => {
  const response = await routeServer.fetch(
    new Request(`${BASE}/me/oauth-connections`, {
      headers: { cookie: browser.cookieHeader() },
    }),
  );
  expect(response.status).toBe(200);
  return v.parse(connectionsSchema, await response.json()).connections;
};

const disconnect = async (browser: HumanBrowser, consentId: string) =>
  await routeServer.fetch(
    new Request(`${BASE}/me/oauth-connections/${consentId}`, {
      method: "DELETE",
      headers: { cookie: browser.cookieHeader() },
    }),
  );

const opensMcpContext = async (accessToken: string): Promise<boolean> => {
  const authenticated = await authenticateMcpRequest(accessToken);
  if (authenticated.isErr()) {
    return false;
  }
  const resolved = await Result.tryPromise(
    async () =>
      await resolveMcpSessionContext(authenticated.value, {
        request: new Request(`${BASE}/mcp`, { method: "POST" }),
      }),
  );
  return resolved.isOk();
};

const signDelegatedUserToken = async (
  userId: string,
  organizationId: string,
): Promise<string> => {
  const issuedAt = Math.floor(Date.now() / 1000);
  return (
    await getAuth().api.signJWT({
      body: {
        payload: {
          sub: userId,
          org_id: organizationId,
          scope: "stella:read",
          aud: getMcpResourceUrl(),
          iss: getAuthIssuerUrl(),
          iat: issuedAt,
          exp: issuedAt + 600,
        },
      },
    })
  ).token;
};

type GrantState = {
  refreshTokenActive: boolean;
  storedAccessTokens: number;
  storedRefreshTokens: number;
  consents: number;
};

type ReadGrantStateOptions = {
  browser: HumanBrowser;
  client: RegisteredOAuthClient;
  grant: OAuthGrant;
  organizationId: string;
};

const readGrantState = async ({
  browser,
  client,
  grant,
  organizationId,
}: ReadGrantStateOptions): Promise<GrantState> => ({
  refreshTokenActive: await isOAuthTokenActive({
    client,
    token: grant.refreshToken,
    tokenTypeHint: "refresh_token",
  }),
  storedAccessTokens: await testDb.$count(
    oauthAccessToken,
    and(
      eq(oauthAccessToken.userId, browser.userId),
      eq(oauthAccessToken.clientId, client.clientId),
      eq(oauthAccessToken.referenceId, organizationId),
    ),
  ),
  storedRefreshTokens: await testDb.$count(
    oauthRefreshToken,
    and(
      eq(oauthRefreshToken.userId, browser.userId),
      eq(oauthRefreshToken.clientId, client.clientId),
      eq(oauthRefreshToken.referenceId, organizationId),
    ),
  ),
  consents: await testDb.$count(
    oauthConsent,
    and(
      eq(oauthConsent.userId, browser.userId),
      eq(oauthConsent.clientId, client.clientId),
      eq(oauthConsent.referenceId, organizationId),
    ),
  ),
});

describe("resource-bound OAuth refresh", () => {
  test.each(["original", "omitted"] as const)(
    "preserves offline access across repeated refreshes with %s scopes",
    async (scopeMode) => {
      const browser = await signInHuman(
        `refresh-${Bun.randomUUIDv7()}@stella.dev`,
      );
      const organization = await getAuth().api.createOrganization({
        body: { name: "Refresh", slug: `refresh-${Bun.randomUUIDv7()}` },
        headers: browser.headers(),
      });
      await browser.setActiveOrganization(organization.id);
      const client = await registerOAuthClient();
      let grant = await grantOAuthClient(browser, client);
      const requestedScope = grant.scope;
      expect(grant.scope.split(" ")).toContain("offline_access");
      for (let rotation = 0; rotation < 2; rotation += 1) {
        const response = await refreshOAuthGrant({
          client,
          refreshToken: grant.refreshToken,
          ...(scopeMode === "original" ? { scope: requestedScope } : {}),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const tokens = v.parse(
          v.looseObject({
            access_token: v.pipe(v.string(), v.minLength(1)),
            refresh_token: v.pipe(v.string(), v.minLength(1)),
            scope: v.string(),
          }),
          await response.json(),
        );
        expect(tokens.scope.split(" ")).toContain("offline_access");
        // The resource scopes granted at consent survive alongside it.
        expect(tokens.scope.split(" ").toSorted()).toEqual(
          requestedScope.split(" ").toSorted(),
        );
        grant = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          scope: tokens.scope,
        };
      }
    },
  );

  test("keeps refreshing after the browser session that granted it ends", async () => {
    const browser = await signInHuman(
      `refresh-signout-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const organization = await getAuth().api.createOrganization({
      body: { name: "Refresh", slug: `refresh-${Bun.randomUUIDv7()}` },
      headers: browser.headers(),
    });
    await browser.setActiveOrganization(organization.id);
    const client = await registerOAuthClient();
    const granted = await grantOAuthClient(browser, client);

    await getAuth().api.signOut({ headers: browser.headers() });

    // The browser session is gone; the offline refresh token must outlive it,
    // so a connected app keeps working without a new sign-in.
    expect(
      await testDb.$count(session, eq(session.userId, browser.userId)),
    ).toBe(0);
    let refreshToken = granted.refreshToken;
    for (let rotation = 0; rotation < 2; rotation += 1) {
      const response = await refreshOAuthGrant({ client, refreshToken });
      expect(response.status, await response.clone().text()).toBe(200);
      const tokens = v.parse(
        v.looseObject({
          access_token: v.pipe(v.string(), v.minLength(1)),
          refresh_token: v.pipe(v.string(), v.minLength(1)),
          scope: v.string(),
        }),
        await response.json(),
      );
      expect(tokens.scope.split(" ")).toContain("offline_access");
      refreshToken = tokens.refresh_token;
    }
  });
});

describe("disconnecting a connected app", () => {
  test("refuses only the disconnected app's already-issued MCP token", async () => {
    const auth = getAuth();
    const owner = await signInHuman(
      `revocation-owner-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const organization = await auth.api.createOrganization({
      body: {
        name: "Revocation",
        slug: `revocation-${Bun.randomUUIDv7()}`,
      },
      headers: owner.headers(),
    });
    await owner.setActiveOrganization(organization.id);

    const other = await signInHuman(
      `revocation-member-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const invitation = await auth.api.createInvitation({
      body: {
        email: other.email,
        organizationId: organization.id,
        role: "admin",
      },
      headers: owner.headers(),
    });
    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: other.headers(),
    });
    await other.setActiveOrganization(organization.id);

    const disconnectedClient = await registerOAuthClient();
    const keptClient = await registerOAuthClient();
    const disconnectedGrant = await grantOAuthClient(owner, disconnectedClient);
    const keptGrant = await grantOAuthClient(owner, keptClient);
    const otherUserGrant = await grantOAuthClient(other, disconnectedClient);
    const delegatedToken = await signDelegatedUserToken(
      owner.userId,
      organization.id,
    );
    const agentRunToken = await mintAgentRunToken({
      userId: toSafeId<"user">(owner.userId),
      organizationId: toSafeId<"organization">(organization.id),
      runId: Bun.randomUUIDv7(),
      workspaceIds: [],
    });

    expect(
      await testDb.$count(
        oauthGrantRevocations,
        and(
          eq(oauthGrantRevocations.organizationId, organization.id),
          eq(oauthGrantRevocations.userId, owner.userId),
          eq(oauthGrantRevocations.oauthClientId, disconnectedClient.clientId),
        ),
      ),
    ).toBe(0);
    expect(await opensMcpContext(disconnectedGrant.accessToken)).toBe(true);
    const connection = (await listConnections(owner)).find(
      ({ clientId }) => clientId === disconnectedClient.clientId,
    );
    if (!connection) {
      throw new Error("The granted connection is not listed");
    }
    expect((await disconnect(owner, connection.id)).status).toBe(200);

    expect(await opensMcpContext(disconnectedGrant.accessToken)).toBe(false);
    expect(await opensMcpContext(keptGrant.accessToken)).toBe(true);
    expect(await opensMcpContext(otherUserGrant.accessToken)).toBe(true);
    expect(await opensMcpContext(delegatedToken)).toBe(true);
    expect(await opensMcpContext(agentRunToken.token)).toBe(true);

    const reconnectedGrant = await grantOAuthClient(owner, disconnectedClient);
    expect(await opensMcpContext(reconnectedGrant.accessToken)).toBe(true);

    const reconnectedConnection = (await listConnections(owner)).find(
      ({ clientId }) => clientId === disconnectedClient.clientId,
    );
    if (!reconnectedConnection) {
      throw new Error("The reconnected grant is not listed");
    }
    expect((await disconnect(owner, reconnectedConnection.id)).status).toBe(
      200,
    );

    expect(await opensMcpContext(disconnectedGrant.accessToken)).toBe(false);
    expect(await opensMcpContext(reconnectedGrant.accessToken)).toBe(false);

    const thirdGrant = await grantOAuthClient(owner, disconnectedClient);
    expect(await opensMcpContext(thirdGrant.accessToken)).toBe(true);
  });

  test("ends that grant's tokens and consent and leaves the user's other connected apps working", async () => {
    const browser = await signInHuman(
      `connections-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const organization = await getAuth().api.createOrganization({
      body: { name: "Connections", slug: `connections-${Bun.randomUUIDv7()}` },
      headers: browser.headers(),
    });
    await browser.setActiveOrganization(organization.id);
    const disconnectedClient = await registerOAuthClient();
    const keptClient = await registerOAuthClient();
    const disconnectedGrant = await grantOAuthClient(
      browser,
      disconnectedClient,
    );
    const keptGrant = await grantOAuthClient(browser, keptClient);

    const disconnectedState = {
      browser,
      client: disconnectedClient,
      grant: disconnectedGrant,
      organizationId: organization.id,
    };
    const keptState = {
      browser,
      client: keptClient,
      grant: keptGrant,
      organizationId: organization.id,
    };
    const live = {
      refreshTokenActive: true,
      storedAccessTokens: 0,
      storedRefreshTokens: 1,
      consents: 1,
    } satisfies GrantState;
    // Both grants have to be live first, and the standing consent has to let
    // the app through without asking, or the assertions below would pass
    // without the disconnect reaching them.
    expect(await readGrantState(disconnectedState)).toEqual(live);
    expect(await readGrantState(keptState)).toEqual(live);
    expect(
      (await authorizeOAuthClient(browser, disconnectedClient)).redirect
        .pathname,
    ).not.toBe(OAUTH_CONSENT_PAGE_PATH);

    const connection = (await listConnections(browser)).find(
      ({ clientId }) => clientId === disconnectedClient.clientId,
    );
    if (!connection) {
      throw new Error("The granted connection is not listed");
    }
    const response = await disconnect(browser, connection.id);
    expect(response.status, await response.clone().text()).toBe(200);

    expect(await readGrantState(disconnectedState)).toEqual({
      refreshTokenActive: false,
      storedAccessTokens: 0,
      storedRefreshTokens: 0,
      consents: 0,
    });
    const telemetry = installRecordingLogger();
    expect(
      (
        await refreshOAuthGrant({
          client: disconnectedClient,
          refreshToken: disconnectedGrant.refreshToken,
        })
      ).ok,
    ).toBe(false);
    const refusals = telemetry.records.filter(
      ({ message }) => message === "auth.request_refused",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals.at(0)?.attributes).toMatchObject({
      "oauth.refusal_reason": "unknown_token",
      "oauth.client_id": disconnectedClient.clientId,
      "oauth.grant_family": "none",
    });
    expect(JSON.stringify(refusals)).not.toContain(
      disconnectedGrant.refreshToken,
    );
    if (disconnectedClient.clientSecret !== undefined) {
      expect(JSON.stringify(refusals)).not.toContain(
        disconnectedClient.clientSecret,
      );
    }
    telemetry.restore();
    expect(
      (await listConnections(browser)).map(({ clientId }) => clientId),
    ).toEqual([keptClient.clientId]);
    // Without the consent, authorizing again asks the user rather than issuing
    // a code on the old approval.
    expect(
      (await authorizeOAuthClient(browser, disconnectedClient)).redirect
        .pathname,
    ).toBe(OAUTH_CONSENT_PAGE_PATH);

    expect(await readGrantState(keptState)).toEqual(live);
    expect(
      (
        await refreshOAuthGrant({
          client: keptClient,
          refreshToken: keptGrant.refreshToken,
        })
      ).ok,
    ).toBe(true);
  });

  test("refuses to disconnect another user's connection", async () => {
    const owner = await signInHuman(
      `connections-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const other = await signInHuman(
      `connections-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const organization = await getAuth().api.createOrganization({
      body: { name: "Owner firm", slug: `connections-${Bun.randomUUIDv7()}` },
      headers: owner.headers(),
    });
    await owner.setActiveOrganization(organization.id);
    const client = await registerOAuthClient();
    const grant = await grantOAuthClient(owner, client);
    const connection = (await listConnections(owner)).at(0);
    if (!connection) {
      throw new Error("The granted connection is not listed");
    }

    expect((await disconnect(other, connection.id)).status).toBe(404);
    expect(
      await readGrantState({
        browser: owner,
        client,
        grant,
        organizationId: organization.id,
      }),
    ).toEqual({
      refreshTokenActive: true,
      storedAccessTokens: 0,
      storedRefreshTokens: 1,
      consents: 1,
    });
  });
});
