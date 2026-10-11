import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";

import type { LoopbackCallback } from "../../../../packages/cli/src/auth/loopback-listener.ts";

/**
 * The stella CLI signing in end to end: the CLI's own login code (discovery,
 * client choice, authorize URL, token exchange) against the real server and
 * auth handler, with only the browser and the loopback listener simulated.
 *
 * The deployment's public address is https here, as in production, so this
 * file runs in a process of its own (`SOLO_TEST_PATHS`) and sets it before
 * anything reads the environment. Requests to it are served in process by
 * the local server.
 */

const PUBLIC_URL = "https://stella-api.example.com";
process.env["PUBLIC_URL"] = PUBLIC_URL;

const { env } = await import("@/api/env");
const { getAuth } = await import("@/api/lib/auth");
const { default: api } = await import("@/api/server");
const { initAgentAuthTestDb, releaseAgentAuthTestDb } =
  await import("@/api/tests/helpers/mock-agent-auth-db");
const { signInHuman } = await import("@/api/tests/helpers/human-session");
const { readSignedQuery } = await import("@/api/tests/helpers/oauth-grant");
const { login } = await import("../../../../packages/cli/src/auth/login.ts");
const { CLI_DEFAULT_RESOURCE_SCOPES, CLI_KNOWN_SCOPES, CLI_REQUIRED_SCOPES } =
  await import("../../../../packages/cli/src/auth/constants.ts");
const { CLI_CLIENT_METADATA_PATH, buildCliClientMetadataDocument } =
  await import("@stll/cli/client-metadata-document");

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
    : await api.handle(local);
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

/** The consent a signed-in user gives in the browser, ending at the CLI's redirect. */
const approveInBrowser = async (
  browser: Browser,
  authorizeUrl: string,
): Promise<LoopbackCallback> => {
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
  const callback = new URL(v.parse(redirectSchema, await consented.json()).url);
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

const signInWithOrganization = async (email: string) => {
  const browser = await signInHuman(email);
  const organization = await getAuth().api.createOrganization({
    body: { name: "CLI sign-in", slug: `cli-${Bun.randomUUIDv7()}` },
    headers: browser.headers(),
  });
  await browser.setActiveOrganization(organization.id);
  return browser;
};

const fetchSpy = spyOn(globalThis, "fetch");

beforeAll(async () => {
  await initAgentAuthTestDb();
  fetchSpy.mockImplementation(
    Object.assign(serveInProcess, { preconnect: fetch.preconnect }),
  );
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await Promise.all(
    configDirs.map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
    }),
  );
  await releaseAgentAuthTestDb();
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
      unverified: false,
      verifiedBrand: "stella",
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
