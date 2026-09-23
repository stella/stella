import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
} from "@/api/db/auth-schema";
import { meRoute } from "@/api/handlers/me/routes";
import { getAuth } from "@/api/lib/auth";
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
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Disconnecting a connected app from the settings page, through the real
// session-authenticated route, against grants minted by the real OAuth
// provider.

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
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
  const response = await meRoute.handle(
    new Request(`${BASE}/me/oauth-connections`, {
      headers: { cookie: browser.cookieHeader() },
    }),
  );
  expect(response.status).toBe(200);
  return v.parse(connectionsSchema, await response.json()).connections;
};

const disconnect = async (browser: HumanBrowser, consentId: string) =>
  await meRoute.handle(
    new Request(`${BASE}/me/oauth-connections/${consentId}`, {
      method: "DELETE",
      headers: { cookie: browser.cookieHeader() },
    }),
  );

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

describe("disconnecting a connected app", () => {
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
    expect(
      (
        await refreshOAuthGrant({
          client: disconnectedClient,
          refreshToken: disconnectedGrant.refreshToken,
        })
      ).ok,
    ).toBe(false);
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
