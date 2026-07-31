import { describe, expect, test } from "bun:test";

import {
  doesSsoEmailMatchDomain,
  getAuth,
  getSessionSsoProviderId,
  getSsoCallbackProviderId,
  stripSsoAccountTokens,
} from "@/api/lib/auth";

describe("SSO session provenance", () => {
  test("extracts provider IDs only from SSO callback routes", () => {
    expect(getSsoCallbackProviderId("/sso/callback/provider%2Fone")).toBe(
      "provider/one",
    );
    expect(getSsoCallbackProviderId("/sso/saml2/sp/acs/provider-one")).toBe(
      "provider-one",
    );
    expect(getSsoCallbackProviderId("/sso/providers")).toBeNull();
    expect(getSsoCallbackProviderId("/sso/callback/%E0%A4%A")).toBeNull();
  });

  test("accepts only complete, server-written SSO provenance", () => {
    expect(
      getSessionSsoProviderId({
        authenticationMethod: "sso",
        ssoProviderId: "provider-one",
      }),
    ).toBe("provider-one");
    expect(
      getSessionSsoProviderId({
        authenticationMethod: "non_sso",
        ssoProviderId: "provider-one",
      }),
    ).toBeNull();
    expect(getSessionSsoProviderId({ authenticationMethod: "sso" })).toBeNull();
  });

  test("requires the asserted email to match the verified provider domain", () => {
    expect(doesSsoEmailMatchDomain("User@EXAMPLE.COM", "example.com")).toBe(
      true,
    );
    expect(doesSsoEmailMatchDomain("user@sub.example.com", "example.com")).toBe(
      false,
    );
    expect(doesSsoEmailMatchDomain("user@other.test", "example.com")).toBe(
      false,
    );
  });

  test("keeps Better Auth's provider-management endpoints unreachable", () => {
    const disabledPaths = getAuth().options.disabledPaths;

    expect(disabledPaths).toContain("/sso/register");
    expect(disabledPaths).toContain("/sso/providers");
    expect(disabledPaths).toContain("/sso/update-provider");
    expect(disabledPaths).toContain("/sso/delete-provider");
    expect(disabledPaths).toContain("/sso/request-domain-verification");
    expect(disabledPaths).toContain("/sso/verify-domain");
    expect(disabledPaths).toContain("/sso/callback");
  });

  test("does not retain SSO OAuth tokens after the callback", () => {
    const account = stripSsoAccountTokens(
      {
        providerId: "sso-provider-one",
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        idToken: "id-secret",
        accessTokenExpiresAt: new Date(),
        refreshTokenExpiresAt: new Date(),
        scope: "openid email",
      },
      "/sso/callback/sso-provider-one",
    );

    expect(account).toMatchObject({
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: "openid email",
    });
  });
});
