import {
  type APIRequestContext,
  request as playwrightRequest,
} from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";

import { expect, test } from "../helpers/test";

const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const AUTH_BASE_URL = `${API_BASE_URL}/api/auth`;
const redirectUriFor = (token: string) =>
  `http://127.0.0.1:54321/callback/${token}`;

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

const registerBrowserClient = async (
  request: APIRequestContext,
  token: string,
): Promise<string> => {
  const response = await request.post(`${AUTH_BASE_URL}/oauth2/register`, {
    data: {
      application_type: "native",
      client_name: `OAuth redirect browser test ${token}`,
      grant_types: ["authorization_code"],
      redirect_uris: [redirectUriFor(token)],
      require_pkce: true,
      response_types: ["code"],
      scope: "openid profile",
      token_endpoint_auth_method: "none",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return readClientId(await response.json());
};

test("the real OAuth authorization redirect keeps its signed query in the fragment", async ({
  page,
}) => {
  const token = randomUUID().replaceAll("-", "");
  const verifier = `oauth-browser-${token}`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const apiRequest = await playwrightRequest.newContext({
    extraHTTPHeaders: { origin: new URL(WEB_BASE_URL).origin },
  });

  try {
    const clientId = await registerBrowserClient(apiRequest, token);
    const authorizeUrl = new URL(`${AUTH_BASE_URL}/oauth2/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("redirect_uri", redirectUriFor(token));
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "openid profile");
    authorizeUrl.searchParams.set("state", `state-${token}`);

    await page.context().clearCookies();
    const authorizeResponsePromise = page.waitForResponse((response) => {
      const responseUrl = new URL(response.url());
      return (
        response.status() === 302 &&
        responseUrl.origin === authorizeUrl.origin &&
        responseUrl.pathname === authorizeUrl.pathname
      );
    });
    const requestUrls: string[] = [];
    page.on("request", (request) => {
      requestUrls.push(request.url());
    });

    await page.goto(authorizeUrl.toString(), { waitUntil: "commit" });
    const authorizeResponse = await authorizeResponsePromise;
    await expect(page.getByRole("heading", { name: /sign in/iu })).toBeVisible({
      timeout: 30_000,
    });
    const locationHeader = authorizeResponse.headers()["location"];
    expect(locationHeader).toBeDefined();

    const redirect = new URL(locationHeader ?? "http://invalid");
    const frontendAuthUrl = new URL("/auth", `${WEB_BASE_URL}/`);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(
      `${frontendAuthUrl.origin}${frontendAuthUrl.pathname}`,
    );
    expect(redirect.search).toBe("");
    const bridgedQuery = new URLSearchParams(redirect.hash.slice(1)).get(
      "oauth_query",
    );
    expect(bridgedQuery).not.toBeNull();
    const bridgedParams = new URLSearchParams(bridgedQuery ?? "");
    expect(bridgedParams.get("client_id")).toBe(clientId);
    expect(bridgedParams.get("code_challenge")).toBe(challenge);
    expect(bridgedParams.get("redirect_uri")).toBe(redirectUriFor(token));
    expect(bridgedParams.get("scope")).toBe("openid profile");
    expect(bridgedParams.get("state")).toBe(`state-${token}`);
    expect(bridgedParams.get("sig")).not.toBeNull();

    const signedRequestUrls = requestUrls.filter((url) => {
      try {
        return new URL(url).searchParams.has("sig");
      } catch {
        return false;
      }
    });
    expect(signedRequestUrls).toEqual([]);
    expect(new URL(page.url()).hash).toBe(redirect.hash);
  } finally {
    await apiRequest.dispose();
  }
});
