import type { APIRequestContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { sha256Base64Url as hashSha256Base64Url } from "@stll/sha256/node";

import { getStorageKey } from "../../src/consts";
import { expect, test } from "../helpers/test";

const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const AUTH_BASE_URL = `${API_BASE_URL}/api/auth`;
const CONSENT_SCOPES = "openid profile stella:read stella:search";
const CALLBACK_PORT = 54_321;
const LOCALE_STORAGE_KEY = getStorageKey("i18n");

const token = () => randomUUID().replaceAll("-", "");
const loopbackRedirectUriFor = (id: string) =>
  `http://127.0.0.1:${CALLBACK_PORT}/oauth-consent/${id}`;
const hostedRedirectUriFor = (id: string) =>
  `https://oauth-client.example/callback/${id}`;

const readClientId = (value: unknown): string => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("client_id" in value) ||
    typeof value.client_id !== "string"
  ) {
    throw new Error("OAuth registration response did not include client_id");
  }
  return value.client_id;
};

type RegisterClientOptions = {
  request: APIRequestContext;
  id: string;
  redirectUri: string;
  scopes?: string;
};

const registerClient = async ({
  request,
  id,
  redirectUri,
  scopes = CONSENT_SCOPES,
}: RegisterClientOptions): Promise<string> => {
  const response = await request.post(`${AUTH_BASE_URL}/oauth2/register`, {
    headers: { origin: new URL(WEB_BASE_URL).origin },
    data: {
      application_type: "native",
      client_name: `Consent browser test ${id}`,
      grant_types: ["authorization_code"],
      redirect_uris: [redirectUri],
      require_pkce: true,
      response_types: ["code"],
      scope: scopes,
      token_endpoint_auth_method: "none",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return readClientId(await response.json());
};

type AuthorizeUrlOptions = {
  clientId: string;
  id: string;
  prompt?: "login" | "select_account";
  redirectUri: string;
  scopes?: string;
};

const authorizeUrlFor = ({
  clientId,
  id,
  prompt,
  redirectUri,
  scopes = CONSENT_SCOPES,
}: AuthorizeUrlOptions) => {
  const verifier = `oauth-consent-${id}`;
  const challenge = hashSha256Base64Url(verifier);
  const authorizeUrl = new URL(`${AUTH_BASE_URL}/oauth2/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", scopes);
  authorizeUrl.searchParams.set("state", `state-${id}`);
  if (prompt !== undefined) {
    authorizeUrl.searchParams.set("prompt", prompt);
  }
  return authorizeUrl.toString();
};

const setEnglishLocale = async (page: Page) => {
  await page.addInitScript(
    ({ storageKey }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ state: { lang: "en" }, version: 0 }),
      );
    },
    { storageKey: LOCALE_STORAGE_KEY },
  );
};

type OpenConsentOptions = {
  page: Page;
  clientId: string;
  id: string;
  redirectUri: string;
};

const openConsent = async ({
  page,
  clientId,
  id,
  redirectUri,
}: OpenConsentOptions) => {
  await page.goto(authorizeUrlFor({ clientId, id, redirectUri }), {
    waitUntil: "commit",
  });
  await expect(
    page.getByRole("heading", {
      name: `Connect Consent browser test ${id} to stella`,
    }),
  ).toBeVisible({ timeout: 30_000 });
};

test("OAuth consent keeps its decision in view on a laptop and a phone", async ({
  context,
  page,
}) => {
  await setEnglishLocale(page);
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const id = token();
    const redirectUri = hostedRedirectUriFor(id);
    const clientId = await registerClient({
      request: context.request,
      id,
      redirectUri,
    });
    await openConsent({ page, clientId, id, redirectUri });
    for (const name of ["Allow", "Decline"]) {
      await expect(page.getByRole("button", { name })).toBeInViewport({
        ratio: 1,
      });
    }
    // A registered client is unverified: its own name, no product mark.
    await expect(page.getByText("Unverified app")).toBeVisible();
    await expect(
      page.locator('[data-slot="verified-client-mark"]'),
    ).toHaveCount(0);
  }
});

test("OAuth consent allows and declines through the top-level callback", async ({
  context,
  page,
}) => {
  await setEnglishLocale(page);
  const apiRequest = context.request;

  const scenarios = [
    { decision: "allow", destination: "loopback" },
    { decision: "allow", destination: "hosted" },
    { decision: "decline", destination: "loopback" },
  ] as const;
  for (const { decision, destination } of scenarios) {
    const id = token();
    const callbackUrl =
      destination === "loopback"
        ? loopbackRedirectUriFor(id)
        : hostedRedirectUriFor(id);
    const clientId = await registerClient({
      request: apiRequest,
      id,
      redirectUri: callbackUrl,
    });
    await page.route(`${callbackUrl}**`, async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>OAuth callback received</title><p>Callback received</p>",
      });
    });

    await openConsent({ page, clientId, id, redirectUri: callbackUrl });
    const callbackRequestPromise = page.waitForRequest((request) =>
      request.url().startsWith(callbackUrl),
    );
    const clickedAt = Date.now();
    await page
      .getByRole("button", {
        name: decision === "allow" ? "Allow" : "Decline",
      })
      .click();

    if (decision === "allow") {
      await expect(
        page.getByRole("heading", {
          name: `Connected to Consent browser test ${id}`,
        }),
      ).toBeVisible();
    }

    const callbackRequest = await callbackRequestPromise;
    expect(callbackRequest.isNavigationRequest()).toBe(true);
    expect(callbackRequest.resourceType()).toBe("document");
    const callback = new URL(callbackRequest.url());
    await expect(page).toHaveURL(
      (url) =>
        url.origin === new URL(callbackUrl).origin &&
        url.pathname === new URL(callbackUrl).pathname,
    );

    const callbackParams = callback.searchParams;
    if (decision === "allow") {
      expect(Date.now() - clickedAt).toBeGreaterThanOrEqual(800);
      expect(callbackParams.get("code")).not.toBeNull();
    } else {
      expect(callbackParams.get("code")).toBeNull();
      expect(callbackParams.get("error")).toBeTruthy();
    }

    await page.unroute(`${callbackUrl}**`);
  }
});

test("account switching preserves the signed OAuth query through auth routing", async ({
  context,
  page,
}) => {
  await setEnglishLocale(page);
  const id = token();
  const redirectUri = loopbackRedirectUriFor(id);
  const clientId = await registerClient({
    request: context.request,
    id,
    redirectUri,
  });

  // Clear this browser session without revoking the shared authenticated fixture.
  let signOutWasIntercepted = false;
  await page.route(`${AUTH_BASE_URL}/sign-out`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    signOutWasIntercepted = true;
    await context.clearCookies();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });

  await openConsent({ page, clientId, id, redirectUri });
  const initialUrl = new URL(page.url());
  const signedQuery = new URLSearchParams(initialUrl.hash.slice(1)).get(
    "oauth_query",
  );
  expect(signedQuery).not.toBeNull();
  const signedHash = initialUrl.hash;

  // The fixture's single organization is auto-selected, so auth routing
  // resumes OAuth instead of stopping on the organization screen. The server
  // re-signs the consent URL after set-active; check the signature on that request.
  const continuation = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/auth/organization/set-active" &&
      request.method() === "POST",
  );
  await page.goto(`${WEB_BASE_URL}/auth${signedHash}`, {
    waitUntil: "commit",
  });
  const continuationRequest = await continuation;
  expect(continuationRequest.postDataJSON()).toMatchObject({
    oauth_query: signedQuery,
  });
  await expect(
    page.getByRole("heading", {
      name: `Connect Consent browser test ${id} to stella`,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL((url) => url.pathname === "/consent");

  const queryBeforeSwitch = new URLSearchParams(
    new URL(page.url()).hash.slice(1),
  ).get("oauth_query");
  expect(queryBeforeSwitch).not.toBeNull();
  await page.getByRole("button", { name: "Use another account" }).click();

  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/auth" &&
      new URLSearchParams(url.hash.slice(1)).get("oauth_query") ===
        queryBeforeSwitch,
  );
  expect(signOutWasIntercepted).toBe(true);
  await expect
    .poll(
      async () =>
        await (
          await context.request.get(`${AUTH_BASE_URL}/get-session`)
        ).json(),
    )
    .toBeNull();
});

test("organization picker names the signed-in account and switches it without losing the OAuth request", async ({
  context,
  page,
}) => {
  await setEnglishLocale(page);
  const id = token();
  const redirectUri = loopbackRedirectUriFor(id);
  const clientId = await registerClient({
    request: context.request,
    id,
    redirectUri,
  });
  const sessionResponse = await context.request.get(
    `${AUTH_BASE_URL}/get-session`,
  );
  const session: unknown = await sessionResponse.json();
  const email =
    typeof session === "object" &&
    session !== null &&
    "user" in session &&
    typeof session.user === "object" &&
    session.user !== null &&
    "email" in session.user &&
    typeof session.user.email === "string"
      ? session.user.email
      : null;
  expect(email).not.toBeNull();

  // The fixture belongs to one organization, which the picker selects on its
  // own; a second membership in the list keeps the picker on screen.
  await page.route(`${AUTH_BASE_URL}/organization/list`, async (route) => {
    const response = await route.fetch();
    const organizations: unknown = await response.json();
    expect(Array.isArray(organizations)).toBe(true);
    await route.fulfill({
      response,
      json: [
        ...(Array.isArray(organizations) ? organizations : []),
        {
          id: `second-organization-${id}`,
          name: `Second organization ${id}`,
          slug: `second-organization-${id}`,
          createdAt: new Date().toISOString(),
        },
      ],
    });
  });

  // Clear this browser session without revoking the shared authenticated fixture.
  let signOutWasIntercepted = false;
  await page.route(`${AUTH_BASE_URL}/sign-out`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    signOutWasIntercepted = true;
    await context.clearCookies();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });

  // The server sends a single-membership account straight to consent; take
  // the signed request from there and open the picker with it, as the
  // organization step of a multi-membership account receives it.
  await openConsent({ page, clientId, id, redirectUri });
  const signedHash = new URL(page.url()).hash;
  const signedQuery = new URLSearchParams(signedHash.slice(1)).get(
    "oauth_query",
  );
  expect(signedQuery).not.toBeNull();
  await page.goto(`${WEB_BASE_URL}/auth/organization${signedHash}`, {
    waitUntil: "commit",
  });
  await expect(
    page.getByText(`Second organization ${id}`, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText("Select an organization", { exact: true }),
  ).toBeVisible();

  const account = page.getByRole("definition").filter({ hasText: email ?? "" });
  await expect(
    page.getByRole("term").filter({ hasText: "Account" }),
  ).toBeVisible();
  await expect(account).toBeVisible();
  await account.getByRole("button", { name: "Use another account" }).click();

  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/auth" &&
      new URLSearchParams(url.hash.slice(1)).get("oauth_query") === signedQuery,
  );
  expect(signOutWasIntercepted).toBe(true);
  await expect
    .poll(
      async () =>
        await (
          await context.request.get(`${AUTH_BASE_URL}/get-session`)
        ).json(),
    )
    .toBeNull();
});

test("a client asking for a fresh sign-in gets the sign-in form despite a session", async ({
  context,
  page,
}) => {
  await setEnglishLocale(page);
  const id = token();
  const redirectUri = loopbackRedirectUriFor(id);
  const clientId = await registerClient({
    request: context.request,
    id,
    redirectUri,
  });

  await page.goto(
    authorizeUrlFor({ clientId, id, prompt: "login", redirectUri }),
    {
      waitUntil: "commit",
    },
  );
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
  await expect(page).toHaveURL((url) => {
    const signedQuery = new URLSearchParams(url.hash.slice(1)).get(
      "oauth_query",
    );
    return (
      url.pathname === "/auth" &&
      signedQuery !== null &&
      new URLSearchParams(signedQuery).get("prompt") === "login"
    );
  });
  // Nothing is signed out until someone signs in.
  expect(
    await (await context.request.get(`${AUTH_BASE_URL}/get-session`)).json(),
  ).not.toBeNull();
});

test("a client asking for account selection gets the organization step with the account switch", async ({
  context,
  page,
}) => {
  await setEnglishLocale(page);
  const id = token();
  const redirectUri = loopbackRedirectUriFor(id);
  const clientId = await registerClient({
    request: context.request,
    id,
    redirectUri,
  });
  const organizationsResponse = await context.request.get(
    `${AUTH_BASE_URL}/organization/list`,
  );
  const organizations: unknown = await organizationsResponse.json();
  const [organization] = Array.isArray(organizations) ? organizations : [];
  const organizationName =
    typeof organization === "object" &&
    organization !== null &&
    "name" in organization &&
    typeof organization.name === "string"
      ? organization.name
      : null;
  expect(organizationName).not.toBeNull();

  // The fixture's single organization would be picked on its own without
  // the prompt; with it, the step stays on screen.
  await page.goto(
    authorizeUrlFor({ clientId, id, prompt: "select_account", redirectUri }),
    { waitUntil: "commit" },
  );
  await expect(
    page.getByText("Select an organization", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL((url) => url.pathname === "/auth/organization");
  await expect(
    page.getByRole("term").filter({ hasText: "Account" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use another account" }),
  ).toBeVisible();

  await page.getByRole("button", { name: organizationName ?? "" }).click();
  await expect(
    page.getByRole("heading", {
      name: `Connect Consent browser test ${id} to stella`,
    }),
  ).toBeVisible({ timeout: 30_000 });
});

test("consent discloses permissions on demand and brands only verified locations", async ({
  context,
  page,
}) => {
  await setEnglishLocale(page);
  const scopes =
    "openid profile offline_access stella:read stella:documents_write stella:matters_write stella:contacts_write stella:billing_write stella:skills stella:templates";
  for (const scenario of [
    {
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      name: "Claude",
      publisher: "Anthropic",
    },
    {
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      name: "ChatGPT",
      publisher: "OpenAI",
    },
    { redirectUri: hostedRedirectUriFor(token()), name: null, publisher: null },
  ]) {
    const id = token();
    const clientId = await registerClient({
      request: context.request,
      id,
      redirectUri: scenario.redirectUri,
      scopes,
    });
    await page.goto(
      authorizeUrlFor({
        clientId,
        id,
        redirectUri: scenario.redirectUri,
        scopes,
      }),
      { waitUntil: "commit" },
    );
    await expect(
      page.getByRole("heading", {
        name: `Connect ${scenario.name ?? `Consent browser test ${id}`} to stella`,
      }),
    ).toBeVisible();
    if (scenario.publisher) {
      await expect(
        page.getByText(`Verified app by ${scenario.publisher}`),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="verified-client-mark"]'),
      ).toHaveCount(1);
      await expect(page.getByText("Unverified app")).toHaveCount(0);
    } else {
      await expect(page.getByText("Unverified app")).toBeVisible();
      await expect(
        page.locator('[data-slot="verified-client-mark"]'),
      ).toHaveCount(0);
      await expect(
        page.locator('[data-slot="unverified-client-mark"]'),
      ).toHaveCount(1);
    }
    await expect(
      page.locator('[data-slot="consent-summary-line"]'),
    ).toHaveCount(4);
    await expect(
      page.locator('[data-slot="consent-sensitive-access"]'),
    ).toHaveCount(1);
    const permission = page.getByText(
      "Create, edit, and delete your documents",
      { exact: true },
    );
    await expect(permission).toBeHidden();
    const disclosure = page.locator(
      '[data-slot="consent-permissions"] > summary',
    );
    await disclosure.click();
    await expect(permission).toBeVisible();
    await disclosure.click();
    await expect(permission).toBeHidden();
    const host = page.getByText(new URL(scenario.redirectUri).host, {
      exact: true,
    });
    await expect(host).toBeHidden();
    const info = page.getByRole("button", { name: "Redirect details" });
    await info.click();
    await expect(host).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(host).toBeHidden();
    await expect(info).toBeFocused();
  }
});
