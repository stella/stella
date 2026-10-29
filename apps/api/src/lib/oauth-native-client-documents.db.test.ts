import {
  afterAll,
  beforeEach,
  describe,
  expect,
  type Mock,
  mock,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";

import { sha256Base64Url } from "@stll/sha256/bun";

import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import type { LoopbackCallback } from "../../../../packages/cli/src/auth/loopback-listener.ts";

const testFetchState = createTestFetch();

/**
 * stella's own native clients signing in end to end against the real server
 * and auth handler. The CLI runs its own sign-in code, with only the browser
 * and its loopback listener simulated. The mobile app is an app of its own,
 * so its sign-in is replayed here at the protocol level, as the app's
 * sign-in code performs it (discovery, the app's client document, PKCE, the
 * person's consent, the code exchange); the app's own tests cover that code. The app's token then reads matters over REST,
 * and every place it must not reach refuses it.
 *
 * The deployment's public address is https here, as in production, so this
 * file runs in a process of its own (`SOLO_TEST_PATHS`) and sets it before
 * anything reads the environment. Requests to it are served in process by
 * the local server.
 */

const PUBLIC_URL = "https://stella-api.example.com";
const testState = createTestState({ file: import.meta.path, config: {} });
testState.setEnv("PUBLIC_URL", PUBLIC_URL);

const { env } = await import("@/api/env");
const { getAuth } = await import("@/api/lib/auth");
const { apiApp } = await import("@/api/server");
const { serveForTest } = await import("@/api/tests/helpers/test-server");
const { initAgentAuthTestDb, releaseAgentAuthTestDb } =
  await import("@/api/tests/helpers/mock-agent-auth-db");
const { signInHuman } = await import("@/api/tests/helpers/human-session");
const { rootDb } = await import("@/api/db/root");
const { workspaceMembers, workspaces } = await import("@/api/db/schema");
const { createSafeId, toSafeId } = await import("@/api/lib/branded-types");
const { readSignedQuery } = await import("@/api/tests/helpers/oauth-grant");
const { login } = await import("../../../../packages/cli/src/auth/login.ts");
const { CLI_DEFAULT_RESOURCE_SCOPES, CLI_KNOWN_SCOPES, CLI_REQUIRED_SCOPES } =
  await import("../../../../packages/cli/src/auth/constants.ts");
const { CLI_CLIENT_METADATA_PATH, buildCliClientMetadataDocument } =
  await import("@stll/cli/client-metadata-document");
const {
  MOBILE_CLIENT_METADATA_PATH,
  MOBILE_SCOPES,
  buildMobileClientMetadataDocument,
  mobileRedirectUri,
} = await import("@stll/api-contract/mobile-client");
const { apiOAuthResourceUrl } =
  await import("@stll/api-contract/api-oauth-resource");
const { readCredentialFile } =
  await import("../../../../packages/cli/src/auth/credential-store.ts");

const api = serveForTest(apiApp);

const MOBILE_CLIENT_ID = `${PUBLIC_URL}${MOBILE_CLIENT_METADATA_PATH}`;
/** The installed app signing in here is the production build. */
const MOBILE_REDIRECT_URI_PRODUCTION = mobileRedirectUri("production");

const CLI_CLIENT_ID = `${PUBLIC_URL}${CLI_CLIENT_METADATA_PATH}`;
/** Where the CLI is pointed: the deployment's public address. */
const SERVER_URL = PUBLIC_URL;
/** Where the test server actually answers. */
const LOCAL_URL = env.BETTER_AUTH_URL;

/** Whether discovery hides client metadata document support, as an older server would. */
let hideDocumentSupport = false;

/** Every request the CLI or the simulated browser makes, served in process. */
const serveInProcess = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const source = input instanceof Request ? input : undefined;
  const url = new URL(input instanceof Request ? input.url : input);
  const body = init?.body ?? (source ? await source.text() : undefined);
  const local = new Request(
    new URL(`${url.pathname}${url.search}`, LOCAL_URL).toString(),
    {
      method: init?.method ?? source?.method ?? "GET",
      headers: new Headers(init?.headers ?? source?.headers),
      ...(body ? { body } : {}),
    },
  );
  const response = url.pathname.startsWith("/api/auth/")
    ? await getAuth().handler(local)
    : await api.fetch(local);
  if (
    !hideDocumentSupport ||
    !url.pathname.endsWith("/.well-known/oauth-authorization-server")
  ) {
    return response;
  }
  const metadata = v.parse(
    v.record(v.string(), v.unknown()),
    await response.json(),
  );
  const { client_id_metadata_document_supported: _hidden, ...rest } = metadata;
  return Response.json(rest, { status: response.status });
};

const redirectSchema = v.looseObject({ url: v.string() });

type Browser = Awaited<ReturnType<typeof signInHuman>>;

/** The consent a signed-in user gives in the browser, ending at the client's redirect. */
const consentInBrowser = async (
  browser: Browser,
  authorizeUrl: string,
): Promise<URL> => {
  const authorized = await serveInProcess(authorizeUrl, {
    headers: { accept: "application/json", cookie: browser.cookieHeader() },
  });
  const consentPage = new URL(
    v.parse(redirectSchema, await authorized.json()).url,
  );
  const consented = await serveInProcess(
    new URL("/api/auth/oauth2/consent", SERVER_URL),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: browser.cookieHeader(),
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: readSignedQuery(consentPage),
      }),
    },
  );
  return new URL(v.parse(redirectSchema, await consented.json()).url);
};

/** The CLI's loopback listener receiving that redirect. */
const approveInBrowser = async (
  browser: Browser,
  authorizeUrl: string,
): Promise<LoopbackCallback> => {
  const callback = await consentInBrowser(browser, authorizeUrl);
  return {
    kind: "success",
    code: callback.searchParams.get("code") ?? "",
    state: callback.searchParams.get("state") ?? "",
  };
};

const configDirs: string[] = [];

/** Run `stella auth login` as the CLI does, with `browser` approving. */
const cliLogin = async (browser: Browser) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "stella-cli-login-"));
  configDirs.push(configDir);
  let delivered: LoopbackCallback | undefined;
  const result = await login(
    process,
    {
      configDir,
      orgHint: undefined,
      registrationScopes: CLI_KNOWN_SCOPES,
      requiredScopes: CLI_REQUIRED_SCOPES,
      resourceScopes: CLI_DEFAULT_RESOURCE_SCOPES,
      serverFlag: SERVER_URL,
    },
    {
      openInBrowser: async (authorizeUrl) => {
        delivered = await approveInBrowser(browser, authorizeUrl);
        return { status: "opened" };
      },
      startLoopbackListener: async () => ({
        port: 43_123,
        redirectUri: "http://127.0.0.1:43123/callback",
        waitForCallback: async () =>
          delivered ?? { kind: "error", error: "no_callback" },
        close: () => {},
      }),
    },
  );
  if (result.isErr()) {
    throw result.error;
  }
  return result.value;
};

const authorizationServerSchema = v.looseObject({
  issuer: v.string(),
  authorization_endpoint: v.string(),
  token_endpoint: v.string(),
  client_id_metadata_document_supported: v.optional(v.boolean()),
});

const tokenResponseSchema = v.looseObject({
  access_token: v.string(),
  refresh_token: v.string(),
});

/** The app's token request, as a form like the app sends. */
const requestTokens = async (
  tokenEndpoint: string,
  parameters: Record<string, string>,
) => {
  const response = await serveInProcess(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters).toString(),
  });
  expect(response.status).toBe(200);
  return v.parse(tokenResponseSchema, await response.json());
};

const base64Url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64url");

/** Sign the mobile app in as it does on a phone, with `browser` approving. */
const mobileSignIn = async (browser: Browser) => {
  const discovered = await serveInProcess(
    new URL("/api/auth/.well-known/oauth-authorization-server", SERVER_URL),
  );
  const metadata = v.parse(authorizationServerSchema, await discovered.json());
  expect(metadata.client_id_metadata_document_supported).toBe(true);
  const resource = apiOAuthResourceUrl(SERVER_URL);
  const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const authorize = new URL(metadata.authorization_endpoint);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: MOBILE_CLIENT_ID,
    redirect_uri: MOBILE_REDIRECT_URI_PRODUCTION,
    code_challenge: sha256Base64Url(codeVerifier),
    code_challenge_method: "S256",
    state,
    resource,
    scope: MOBILE_SCOPES.join(" "),
    prompt: "consent",
  })) {
    authorize.searchParams.set(name, value);
  }
  const callback = await consentInBrowser(browser, authorize.toString());
  expect(`${callback.protocol}${callback.pathname}`).toBe(
    MOBILE_REDIRECT_URI_PRODUCTION,
  );
  expect(callback.searchParams.get("state")).toBe(state);
  const tokens = await requestTokens(metadata.token_endpoint, {
    grant_type: "authorization_code",
    client_id: MOBILE_CLIENT_ID,
    code: callback.searchParams.get("code") ?? "",
    code_verifier: codeVerifier,
    redirect_uri: MOBILE_REDIRECT_URI_PRODUCTION,
    resource,
  });
  return {
    session: {
      clientId: MOBILE_CLIENT_ID,
      tokenEndpoint: metadata.token_endpoint,
      resource,
      refreshToken: tokens.refresh_token,
    },
    access: { token: tokens.access_token },
  };
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const signInWithOrganization = async (email: string) => {
  const browser = await signInHuman(email);
  const organization = await getAuth().api.createOrganization({
    body: { name: "CLI sign-in", slug: `cli-${Bun.randomUUIDv7()}` },
    headers: browser.headers(),
  });
  await browser.setActiveOrganization(organization.id);
  return { ...browser, organizationId: organization.id };
};

let fetchSpy: Mock<typeof globalThis.fetch>;

testState.beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  testFetchState.restore();
  await api.stop();
  await Promise.all(
    configDirs.map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
    }),
  );
  await releaseAgentAuthTestDb();
});

beforeEach(() => {
  fetchSpy = Object.assign(
    mock(Object.assign(serveInProcess, { preconnect: fetch.preconnect })),
    { preconnect: globalThis.fetch.preconnect },
  );
  testFetchState.set(asFetchMock(fetchSpy));
});

describe("stella CLI client document", () => {
  test("is published at the CLI's client id", async () => {
    const response = await serveInProcess(CLI_CLIENT_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await response.json()).toEqual(
      structuredClone(buildCliClientMetadataDocument(CLI_CLIENT_ID)),
    );
  });

  test("signs the CLI in with every scope it asks for", async () => {
    hideDocumentSupport = false;
    const browser = await signInWithOrganization("cli-document@example.test");
    const signedIn = await cliLogin(browser);
    expect(signedIn.grantedScopes.split(" ")).toEqual(
      expect.arrayContaining(["stella:read", "stella:admin_read"]),
    );

    const details = await serveInProcess(
      new URL(
        `/api/auth/oauth2/consent-info?client_id=${encodeURIComponent(CLI_CLIENT_ID)}`,
        SERVER_URL,
      ),
      { headers: { cookie: browser.cookieHeader() } },
    );
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({
      clientIdHost: "stella-api.example.com",
      client: { type: "verified", brand: "stella" },
    });
  });

  test("a registered client with the same redirects gets the open subset", async () => {
    hideDocumentSupport = true;
    try {
      const browser = await signInWithOrganization(
        "cli-registered@example.test",
      );
      const signedIn = await cliLogin(browser);
      const granted = signedIn.grantedScopes.split(" ");
      expect(granted).toContain("stella:read");
      expect(granted).not.toContain("stella:admin_read");
    } finally {
      hideDocumentSupport = false;
    }
  });
});

describe("stella mobile client document", () => {
  test("is published at the app's client id", async () => {
    const response = await serveInProcess(MOBILE_CLIENT_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await response.json()).toEqual(
      structuredClone(buildMobileClientMetadataDocument(MOBILE_CLIENT_ID)),
    );
  });

  test("signs the app in for the REST API, which then lists the person's matters", async () => {
    hideDocumentSupport = false;
    const browser = await signInWithOrganization(
      "mobile-document@example.test",
    );
    const workspaceId = createSafeId<"workspace">();
    await rootDb.insert(workspaces).values({
      id: workspaceId,
      organizationId: toSafeId<"organization">(browser.organizationId),
      name: "Mobile matter",
      reference: workspaceId,
    });
    await rootDb
      .insert(workspaceMembers)
      .values({ workspaceId, userId: browser.userId });

    const signedIn = await mobileSignIn(browser);
    expect(signedIn.session).toMatchObject({
      clientId: MOBILE_CLIENT_ID,
      resource: `${PUBLIC_URL}/v1`,
    });

    const listed = await serveInProcess(new URL("/v1/workspaces", SERVER_URL), {
      headers: bearer(signedIn.access.token),
    });
    expect(listed.status).toBe(200);
    const body = v.parse(
      v.looseObject({
        workspaces: v.array(v.looseObject({ name: v.string() })),
      }),
      await listed.json(),
    );
    expect(body.workspaces.map(({ name }) => name)).toContain("Mobile matter");

    const details = await serveInProcess(
      new URL(
        `/api/auth/oauth2/consent-info?client_id=${encodeURIComponent(MOBILE_CLIENT_ID)}`,
        SERVER_URL,
      ),
      { headers: { cookie: browser.cookieHeader() } },
    );
    expect(await details.json()).toMatchObject({
      clientIdHost: "stella-api.example.com",
      client: { type: "verified", brand: "stella" },
    });
  });

  test("the app's token opens no route it is not listed for, and no MCP audience", async () => {
    const browser = await signInWithOrganization("mobile-reach@example.test");
    const { access } = await mobileSignIn(browser);

    const unlisted = await serveInProcess(new URL("/v1/contacts", SERVER_URL), {
      headers: bearer(access.token),
    });
    expect(unlisted.status).toBe(403);
    expect(unlisted.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope"',
    );

    const accountControl = await serveInProcess(
      new URL("/v1/me/oauth-connections", SERVER_URL),
      { headers: bearer(access.token) },
    );
    expect(accountControl.status).toBe(401);

    const mcp = await serveInProcess(new URL("/mcp", SERVER_URL), {
      method: "POST",
      headers: {
        ...bearer(access.token),
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
  });

  test("no client but the app is granted the REST API", async () => {
    const browser = await signInWithOrganization(
      "cli-api-resource@example.test",
    );
    const authorize = new URL("/api/auth/oauth2/authorize", SERVER_URL);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: CLI_CLIENT_ID,
      redirect_uri: "http://127.0.0.1:43123/callback",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "third-party-state",
      resource: `${PUBLIC_URL}/v1`,
      scope: "openid stella:read",
    })) {
      authorize.searchParams.set(name, value);
    }
    const response = await serveInProcess(authorize, {
      headers: { accept: "application/json", cookie: browser.cookieHeader() },
    });
    const body: unknown = await response.json();
    const redirect = v.safeParse(redirectSchema, body);
    const redirectedTo = redirect.success ? new URL(redirect.output.url) : null;
    // Refused at the authorization step: no consent page, no code.
    expect({
      status: response.status,
      error: redirectedTo?.searchParams.get("error") ?? null,
      consent: redirectedTo?.pathname.includes("consent") ?? false,
    }).toMatchObject({ consent: false });
    expect(
      response.status >= 400 ||
        redirectedTo?.searchParams.get("error") === "invalid_target",
    ).toBe(true);
  });

  test("a token minted for MCP does not open the REST API", async () => {
    const browser = await signInWithOrganization("cli-on-rest@example.test");
    const cli = await cliLogin(browser);
    expect(cli.hasRefreshToken).toBe(true);
    const stored = await readCredentialFile(configDirs.at(-1) ?? "");
    const token = stored.credentials.at(0)?.accessToken ?? "";
    expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/u);

    const listed = await serveInProcess(new URL("/v1/workspaces", SERVER_URL), {
      headers: bearer(token),
    });
    expect(listed.status).toBe(401);
    expect(listed.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"',
    );
  });

  test("the app's session refreshes and rotates its refresh token", async () => {
    const browser = await signInWithOrganization("mobile-refresh@example.test");
    const signedIn = await mobileSignIn(browser);
    const refreshed = await requestTokens(signedIn.session.tokenEndpoint, {
      grant_type: "refresh_token",
      client_id: signedIn.session.clientId,
      refresh_token: signedIn.session.refreshToken,
      resource: signedIn.session.resource,
    });
    expect(refreshed.access_token).not.toBe(signedIn.access.token);
    expect(refreshed.refresh_token).not.toBe(signedIn.session.refreshToken);

    const listed = await serveInProcess(new URL("/v1/workspaces", SERVER_URL), {
      headers: bearer(refreshed.access_token),
    });
    expect(listed.status).toBe(200);
  });
});
