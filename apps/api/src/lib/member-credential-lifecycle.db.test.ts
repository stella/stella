import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import * as v from "valibot";

import { apiKeysRoute } from "@/api/handlers/api-keys/routes";
import { desktopRegistryRoute } from "@/api/handlers/desktop-registry/routes";
import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth-paths";
import { authorizeDesktopRegistry } from "@/api/lib/business-registries/desktop/auth";
import { resolveMachineApiKeySession } from "@/api/mcp/api-key-auth";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  grantOAuthClient,
  isOAuthTokenActive,
  refreshOAuthGrant,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";
import type {
  OAuthGrant,
  RegisteredOAuthClient,
} from "@/api/tests/helpers/oauth-grant";

// One member's whole credential set, minted through the endpoints that issue
// each kind in production, then checked against the verifier that accepts it
// in production. Membership removal and re-invitation go through the
// organization plugin, so the lifecycle hook under test is the one that runs.

setDefaultTimeout(120_000);

// The MCP verifier loads the signing keys over HTTP; serve that one address
// from the real auth handler so the token path runs unchanged.
const passThroughFetch = globalThis.fetch;
const fetchSpy = spyOn(globalThis, "fetch");

beforeAll(async () => {
  await initAgentAuthTestDb();
  const jwksUrl = getAuthEndpointUrl("jwks");
  const serveJwks: typeof fetch = Object.assign(
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
  );
  fetchSpy.mockImplementation(serveJwks);
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await releaseAgentAuthTestDb();
});

const BASE = "http://localhost";

const createdKeySchema = v.looseObject({ key: v.string() });

const postJson = async (
  route: { handle: (request: Request) => Promise<Response> },
  path: string,
  browser: HumanBrowser,
  body: Record<string, unknown>,
) =>
  await route.handle(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: browser.cookieHeader(),
      },
      body: JSON.stringify(body),
    }),
  );

const readCreatedKey = async (response: Response): Promise<string> => {
  expect(response.status, await response.clone().text()).toBe(200);
  return v.parse(createdKeySchema, await response.json()).key;
};

type MemberCredentials = {
  browser: HumanBrowser;
  machineKey: string;
  desktopKey: string;
  oauthClient: RegisteredOAuthClient;
  oauthGrant: OAuthGrant;
};

type CredentialCheck = Record<
  "session" | "machineKey" | "desktopKey" | "oauthAccess" | "oauthRefresh",
  boolean
>;

/** Ask each credential's own verifier whether it still authenticates. */
const checkCredentials = async ({
  browser,
  machineKey,
  desktopKey,
  oauthClient,
  oauthGrant,
}: MemberCredentials): Promise<CredentialCheck> => {
  const session = await getAuth().api.getSession({
    headers: browser.headers(),
    query: { disableCookieCache: true },
  });
  const machine = await Result.tryPromise(
    async () => await resolveMachineApiKeySession(machineKey),
  );
  const desktop = await authorizeDesktopRegistry(
    new Request(`${BASE}/desktop-registry/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${desktopKey}` },
    }),
  );
  return {
    session: session !== null,
    machineKey: machine.isOk(),
    desktopKey: desktop.isOk(),
    oauthAccess: await isOAuthTokenActive({
      client: oauthClient,
      token: oauthGrant.accessToken,
      tokenTypeHint: "access_token",
    }),
    // Introspection first: it reports the refresh token without spending it,
    // so the exchange below is the only rotation this check ever causes.
    oauthRefresh:
      (await isOAuthTokenActive({
        client: oauthClient,
        token: oauthGrant.refreshToken,
        tokenTypeHint: "refresh_token",
      })) ||
      (
        await refreshOAuthGrant({
          client: oauthClient,
          refreshToken: oauthGrant.refreshToken,
        })
      ).ok,
  };
};

const NOTHING_AUTHENTICATES: CredentialCheck = {
  session: false,
  machineKey: false,
  desktopKey: false,
  oauthAccess: false,
  oauthRefresh: false,
};

type InviteIntoOrganizationOptions = {
  owner: HumanBrowser;
  invitee: HumanBrowser;
  organizationId: string;
};

const inviteIntoOrganization = async ({
  owner,
  invitee,
  organizationId,
}: InviteIntoOrganizationOptions) => {
  const auth = getAuth();
  const invitation = await auth.api.createInvitation({
    body: { email: invitee.email, role: "admin", organizationId },
    headers: owner.headers(),
  });
  await auth.api.acceptInvitation({
    body: { invitationId: invitation.id },
    headers: invitee.headers(),
  });
  await invitee.setActiveOrganization(organizationId);
};

/** Whether an OAuth access token opens an MCP request context. */
const opensMcpContext = async (accessToken: string): Promise<boolean> => {
  const session = await authenticateMcpRequest(accessToken);
  if (session.isErr()) {
    return false;
  }
  const context = await Result.tryPromise(
    async () =>
      await resolveMcpSessionContext(session.value, {
        request: new Request(`${BASE}/mcp`, { method: "POST" }),
      }),
  );
  return context.isOk();
};

describe("organization member credential lifecycle", () => {
  test("removing a member ends every credential they hold in that organization, and re-inviting them restores none", async () => {
    const auth = getAuth();
    const owner = await signInHuman(`owner-${Bun.randomUUIDv7()}@stella.dev`);
    const organization = await auth.api.createOrganization({
      body: {
        name: "Credential lifecycle",
        slug: `credential-lifecycle-${Bun.randomUUIDv7()}`,
      },
      headers: owner.headers(),
    });
    await owner.setActiveOrganization(organization.id);

    const memberEmail = `member-${Bun.randomUUIDv7()}@stella.dev`;
    const member = await signInHuman(memberEmail);
    await inviteIntoOrganization({
      owner,
      invitee: member,
      organizationId: organization.id,
    });

    const oauthClient = await registerOAuthClient();
    const credentials: MemberCredentials = {
      browser: member,
      machineKey: await readCreatedKey(
        await postJson(apiKeysRoute, "/api-keys", member, {
          name: "CI",
          scopes: ["stella:read"],
          permissions: { workspace: ["read"] },
        }),
      ),
      desktopKey: await readCreatedKey(
        await postJson(
          desktopRegistryRoute,
          "/desktop-registry/grant",
          member,
          {},
        ),
      ),
      oauthClient,
      oauthGrant: await grantOAuthClient(member, oauthClient),
    };

    // Every credential has to work before removal, or the assertions below
    // would pass without the lifecycle ever reaching it.
    expect(await checkCredentials(credentials)).toEqual({
      session: true,
      machineKey: true,
      desktopKey: true,
      oauthAccess: true,
      oauthRefresh: true,
    });

    await auth.api.removeMember({
      body: { memberIdOrEmail: memberEmail, organizationId: organization.id },
      headers: owner.headers(),
    });

    expect(await checkCredentials(credentials)).toEqual(NOTHING_AUTHENTICATES);

    // The member signs in again and accepts a fresh invitation: the membership
    // every verifier consults is back, but none of the old credentials are.
    const returningMember = await signInHuman(memberEmail);
    await inviteIntoOrganization({
      owner,
      invitee: returningMember,
      organizationId: organization.id,
    });

    expect(await checkCredentials(credentials)).toEqual(NOTHING_AUTHENTICATES);
  });

  test("an OAuth access token opens MCP only for the membership it was issued under", async () => {
    const auth = getAuth();
    const owner = await signInHuman(`owner-${Bun.randomUUIDv7()}@stella.dev`);
    const organization = await auth.api.createOrganization({
      body: {
        name: "Token membership",
        slug: `token-membership-${Bun.randomUUIDv7()}`,
      },
      headers: owner.headers(),
    });
    await owner.setActiveOrganization(organization.id);

    const memberEmail = `member-${Bun.randomUUIDv7()}@stella.dev`;
    const member = await signInHuman(memberEmail);
    await inviteIntoOrganization({
      owner,
      invitee: member,
      organizationId: organization.id,
    });

    const oauthClient = await registerOAuthClient();
    const firstGrant = await grantOAuthClient(member, oauthClient);
    expect(await opensMcpContext(firstGrant.accessToken)).toBe(true);

    await auth.api.removeMember({
      body: { memberIdOrEmail: memberEmail, organizationId: organization.id },
      headers: owner.headers(),
    });
    expect(await opensMcpContext(firstGrant.accessToken)).toBe(false);

    const returningMember = await signInHuman(memberEmail);
    await inviteIntoOrganization({
      owner,
      invitee: returningMember,
      organizationId: organization.id,
    });

    // The access token is still within its lifetime and its signature is
    // valid; the new membership is a different row, so it no longer opens.
    expect(await opensMcpContext(firstGrant.accessToken)).toBe(false);
    const secondGrant = await grantOAuthClient(returningMember, oauthClient);
    expect(await opensMcpContext(secondGrant.accessToken)).toBe(true);
  });
});
