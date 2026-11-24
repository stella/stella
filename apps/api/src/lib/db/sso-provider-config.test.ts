import { describe, expect, test } from "bun:test";

import {
  admitSsoOidcConfig,
  admitSsoSamlConfig,
} from "@/api/lib/db/sso-provider-config";

describe("admitSsoSamlConfig", () => {
  test("accepts hardened SP-initiated SAML config with signed assertions", () => {
    const res = admitSsoSamlConfig(
      JSON.stringify({
        entryPoint: "https://idp.example.com/sso/saml",
        cert: "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----",
        wantAssertionsSigned: true,
        overrideUserInfo: false,
        allowIdpInitiated: false,
      }),
    );
    expect(res.isOk()).toBe(true);
  });

  test("rejects unsigned assertions, HTTP entryPoint, and IdP-initiated SAML", () => {
    expect(
      admitSsoSamlConfig(
        JSON.stringify({
          entryPoint: "https://idp.example.com/sso/saml",
          cert: "CERT",
          wantAssertionsSigned: false,
        }),
      ).isErr(),
    ).toBe(true);

    expect(
      admitSsoSamlConfig(
        JSON.stringify({
          entryPoint: "http://idp.example.com/sso/saml",
          cert: "CERT",
          wantAssertionsSigned: true,
        }),
      ).isErr(),
    ).toBe(true);

    expect(
      admitSsoSamlConfig(
        JSON.stringify({
          entryPoint: "https://idp.example.com/sso/saml",
          cert: "CERT",
          wantAssertionsSigned: true,
          allowIdpInitiated: true,
        }),
      ).isErr(),
    ).toBe(true);
  });

  test("admitSsoOidcConfig still enforces PKCE and no IdP-initiated sign-in", () => {
    expect(admitSsoOidcConfig(JSON.stringify({ pkce: true })).isOk()).toBe(
      true,
    );
    expect(admitSsoOidcConfig(JSON.stringify({ pkce: false })).isErr()).toBe(
      true,
    );
  });
});
