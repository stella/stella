import { describe, expect, test } from "bun:test";

import {
  OAUTH_UI_CONSENT_PATH,
  OAUTH_UI_LOGIN_PATH,
  OAUTH_UI_ORGANIZATION_PATH,
} from "@/api/lib/auth-paths";
import {
  bridgeOauthUiInteraction,
  bridgeOauthUiRedirect,
} from "@/api/lib/oauth-ui-fragment";

const authOrigin = "https://api.stella.example";
const frontendUrl = "https://app.stella.example";
const rawQuery =
  "client_id=cli&ba_param=redirect_uri&ba_param=scope&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback&scope=openid%20stella%3Aread&sig=signed%2Bvalue%3D";

describe("OAuth UI fragment bridge", () => {
  test.each([
    [OAUTH_UI_LOGIN_PATH, "/auth"],
    [OAUTH_UI_ORGANIZATION_PATH, "/auth/organization"],
    [OAUTH_UI_CONSENT_PATH, "/consent"],
  ])(
    "keeps signed interaction state off the network for %s",
    (apiPath, frontendPath) => {
      const bridged = bridgeOauthUiRedirect({
        authOrigin,
        frontendUrl,
        location: `${apiPath}?${rawQuery}`,
      });

      expect(bridged).not.toBeNull();
      const redirect = new URL(bridged ?? "http://invalid");
      expect(`${redirect.origin}${redirect.pathname}`).toBe(
        `${frontendUrl}${frontendPath}`,
      );
      expect(redirect.search).toBe("");
      expect(
        new URLSearchParams(redirect.hash.slice(1)).get("oauth_query"),
      ).toBe(rawQuery);
    },
  );

  test("rewrites the browser redirect before a CDN can inspect its query", () => {
    const responseHeaders = new Headers({
      location: `${OAUTH_UI_LOGIN_PATH}?${rawQuery}`,
    });
    const interaction = { responseHeaders, returned: undefined };

    bridgeOauthUiInteraction(interaction, { authOrigin, frontendUrl });

    const location = responseHeaders.get("location");
    expect(location).not.toBeNull();
    const redirect = new URL(location ?? "http://invalid");
    expect(redirect.search).toBe("");
    expect(redirect.hash).toContain("oauth_query=");
  });

  test("rewrites fetch-mode redirects used between organization and consent", () => {
    const interaction: {
      responseHeaders: Headers | undefined;
      returned: unknown;
    } = {
      responseHeaders: undefined,
      returned: {
        redirect: true,
        url: `${OAUTH_UI_CONSENT_PATH}?${rawQuery}`,
      },
    };

    bridgeOauthUiInteraction(interaction, { authOrigin, frontendUrl });

    expect(interaction.returned).toEqual({
      redirect: true,
      url: expect.stringContaining(`${frontendUrl}/consent#oauth_query=`),
    });
  });

  test.each([
    [
      "unsigned interaction",
      `${OAUTH_UI_LOGIN_PATH}?redirect_uri=http://127.0.0.1/callback`,
    ],
    [
      "unrelated client redirect",
      "http://127.0.0.1:54321/callback?code=secret&sig=value",
    ],
    [
      "lookalike external route",
      `https://attacker.example${OAUTH_UI_LOGIN_PATH}?${rawQuery}`,
    ],
  ])("does not rewrite %s", (_name, location) => {
    expect(
      bridgeOauthUiRedirect({ authOrigin, frontendUrl, location }),
    ).toBeNull();
  });
});
