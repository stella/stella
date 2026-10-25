import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { decodeJwt } from "jose";

import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  authorizeOAuthClient,
  consentAndExchange,
  OAUTH_CONSENT_PAGE_PATH,
  OAUTH_LOGIN_PAGE_PATH,
  OAUTH_ORGANIZATION_PAGE_PATH,
  readOAuthRedirect,
  readSignedQuery,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";

// A user in several organizations picks one on the organization page before
// consent. The page's continue step goes through the real provider handler,
// posting the signed query and flags the web page sends.

setDefaultTimeout(120_000);

beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const createOrganization = async (owner: HumanBrowser, name: string) =>
  await getAuth().api.createOrganization({
    body: { name, slug: `${name.toLowerCase()}-${Bun.randomUUIDv7()}` },
    headers: owner.headers(),
  });

type ContinueAfterPickingOptions = {
  browser: HumanBrowser;
  picker: URL;
  status: "selected" | "created";
};

/** Post the organization page's continue step, as the web page does. */
const continueAfterPicking = async ({
  browser,
  picker,
  status,
}: ContinueAfterPickingOptions): Promise<URL> =>
  await readOAuthRedirect(
    await getAuth().handler(
      new Request(getAuthEndpointUrl("oauth2/continue"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: browser.cookieHeader(),
        },
        body: JSON.stringify({
          [status]: true,
          postLogin: true,
          oauth_query: readSignedQuery(picker),
        }),
      }),
    ),
  );

describe("OAuth organization picker", () => {
  test("a user in two organizations picks one and the grant is scoped to it", async () => {
    const browser = await signInHuman(
      `picker-${Bun.randomUUIDv7()}@stella.dev`,
    );
    await createOrganization(browser, "First");
    const second = await createOrganization(browser, "Second");
    const client = await registerOAuthClient();

    const { codeVerifier, redirect: picker } = await authorizeOAuthClient(
      browser,
      client,
    );
    expect(picker.pathname).toBe(OAUTH_ORGANIZATION_PAGE_PATH);

    await browser.setActiveOrganization(second.id);
    const consentPage = await continueAfterPicking({
      browser,
      picker,
      status: "selected",
    });
    expect(consentPage.pathname).toBe(OAUTH_CONSENT_PAGE_PATH);

    const grant = await consentAndExchange({
      browser,
      client,
      codeVerifier,
      consentPage,
    });
    expect(decodeJwt(grant.accessToken)["org_id"]).toBe(second.id);
  });

  test("an organization created on the picker page continues to consent", async () => {
    const browser = await signInHuman(
      `picker-${Bun.randomUUIDv7()}@stella.dev`,
    );
    await createOrganization(browser, "First");
    await createOrganization(browser, "Second");
    const client = await registerOAuthClient();

    const { redirect: picker } = await authorizeOAuthClient(browser, client);
    expect(picker.pathname).toBe(OAUTH_ORGANIZATION_PAGE_PATH);

    const created = await createOrganization(browser, "Third");
    await browser.setActiveOrganization(created.id);
    const consentPage = await continueAfterPicking({
      browser,
      picker,
      status: "created",
    });
    expect(consentPage.pathname).toBe(OAUTH_CONSENT_PAGE_PATH);
  });

  test("a client asking for account selection gets the organization step even for one organization", async () => {
    const browser = await signInHuman(
      `picker-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const only = await createOrganization(browser, "Only");
    await browser.setActiveOrganization(only.id);
    const client = await registerOAuthClient();

    const { codeVerifier, redirect: picker } = await authorizeOAuthClient(
      browser,
      client,
      undefined,
      "select_account",
    );
    expect(picker.pathname).toBe(OAUTH_ORGANIZATION_PAGE_PATH);
    expect(new URLSearchParams(readSignedQuery(picker)).get("prompt")).toBe(
      "select_account",
    );

    const consentPage = await continueAfterPicking({
      browser,
      picker,
      status: "selected",
    });
    expect(consentPage.pathname).toBe(OAUTH_CONSENT_PAGE_PATH);
    expect(
      new URLSearchParams(readSignedQuery(consentPage)).get("prompt") ?? "",
    ).not.toContain("select_account");

    const grant = await consentAndExchange({
      browser,
      client,
      codeVerifier,
      consentPage,
    });
    expect(decodeJwt(grant.accessToken)["org_id"]).toBe(only.id);
  });

  test("a fresh sign-in request issues no code to the session it asked to replace", async () => {
    const browser = await signInHuman(
      `picker-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const only = await createOrganization(browser, "Only");
    await browser.setActiveOrganization(only.id);
    const client = await registerOAuthClient();

    const { redirect: signIn } = await authorizeOAuthClient(
      browser,
      client,
      undefined,
      "login",
    );
    expect(signIn.pathname).toBe(OAUTH_LOGIN_PAGE_PATH);
    expect(new URLSearchParams(readSignedQuery(signIn)).get("prompt")).toBe(
      "login",
    );

    // The user leaves the sign-in form without signing in. Every step the web
    // pages can post with that request, under the session that was already
    // there, sends the browser back to sign-in instead of to the client.
    const continuations = [
      await continueAfterPicking({
        browser,
        picker: signIn,
        status: "selected",
      }),
      await continueAfterPicking({
        browser,
        picker: signIn,
        status: "created",
      }),
      await readOAuthRedirect(
        await getAuth().handler(
          new Request(getAuthEndpointUrl("oauth2/consent"), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: browser.cookieHeader(),
            },
            body: JSON.stringify({
              accept: true,
              oauth_query: readSignedQuery(signIn),
            }),
          }),
        ),
      ),
    ];
    for (const redirect of continuations) {
      expect(redirect.pathname).toBe(OAUTH_LOGIN_PAGE_PATH);
      expect(redirect.searchParams.has("code")).toBe(false);
      expect(new URLSearchParams(readSignedQuery(redirect)).get("prompt")).toBe(
        "login",
      );
    }
  });

  test("authorizing again without the continue step still asks for the organization", async () => {
    const browser = await signInHuman(
      `picker-${Bun.randomUUIDv7()}@stella.dev`,
    );
    await createOrganization(browser, "First");
    const second = await createOrganization(browser, "Second");
    await browser.setActiveOrganization(second.id);
    const client = await registerOAuthClient();

    const { redirect } = await authorizeOAuthClient(browser, client);
    expect(redirect.pathname).toBe(OAUTH_ORGANIZATION_PAGE_PATH);
  });
});
