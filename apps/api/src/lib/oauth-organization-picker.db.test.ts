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
import { getAuthEndpointUrl } from "@/api/lib/auth-paths";
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
