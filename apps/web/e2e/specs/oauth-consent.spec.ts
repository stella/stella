import type { APIRequestContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { sha256Base64Url as hashSha256Base64Url } from "@stll/sha256/node";

import { getStorageKey } from "../../src/consts";
import { expect, test } from "../helpers/test";

const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const AUTH_BASE_URL = `${API_BASE_URL}/api/auth`;
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
};

const registerClient = async ({
  request,
  id,
  redirectUri,
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
      scope: "openid profile stella:read stella:search",
      token_endpoint_auth_method: "none",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return readClientId(await response.json());
};

type AuthorizeUrlOptions = {
  clientId: string;
  id: string;
  redirectUri: string;
};

const authorizeUrlFor = ({
  clientId,
  id,
  redirectUri,
}: AuthorizeUrlOptions) => {
  const verifier = `oauth-consent-${id}`;
  const challenge = hashSha256Base64Url(verifier);
  const authorizeUrl = new URL(`${AUTH_BASE_URL}/oauth2/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set(
    "scope",
    "openid profile stella:read stella:search",
  );
  authorizeUrl.searchParams.set("state", `state-${id}`);
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
