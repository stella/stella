import { describe, expect, test } from "bun:test";

import {
  deriveDiscoveryEndpoint,
  probeOidcDiscovery,
} from "@/api/lib/auth/sso-discovery";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

const okJsonBytes = (payload: unknown) =>
  new TextEncoder().encode(JSON.stringify(payload));

describe("probeOidcDiscovery", () => {
  test("derives /.well-known/openid-configuration from issuer and rejects non-HTTPS", () => {
    const ok = deriveDiscoveryEndpoint(
      "https://idp.example.com/oauth2/default/",
    );
    expect(ok.isOk()).toBe(true);
    if (ok.isOk()) {
      expect(ok.value).toBe(
        "https://idp.example.com/oauth2/default/.well-known/openid-configuration",
      );
    }

    const insecure = deriveDiscoveryEndpoint("http://idp.example.com");
    expect(insecure.isErr()).toBe(true);
    if (insecure.isErr()) {
      expect(insecure.error.reason).toBe("invalid_url");
    }
  });

  test("validates a matching discovery document", async () => {
    const result = await probeOidcDiscovery({
      issuer: "https://idp.example.com",
      permit: grantThirdPartyOutboundPermit(),
      fetchBytes: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        bytes: okJsonBytes({
          issuer: "https://idp.example.com/",
          authorization_endpoint: "https://idp.example.com/authorize",
          token_endpoint: "https://idp.example.com/token",
          jwks_uri: "https://idp.example.com/jwks",
        }),
        finalUrl: "https://idp.example.com/.well-known/openid-configuration",
      }),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.authorizationEndpoint).toBe(
        "https://idp.example.com/authorize",
      );
      expect(result.value.jwksUri).toBe("https://idp.example.com/jwks");
    }
  });

  test("rejects when discovery document issuer mismatches configured issuer", async () => {
    const result = await probeOidcDiscovery({
      issuer: "https://idp.example.com",
      permit: grantThirdPartyOutboundPermit(),
      fetchBytes: async () => ({
        status: 200,
        headers: new Headers(),
        bytes: okJsonBytes({
          issuer: "https://evil.example.com",
          authorization_endpoint: "https://idp.example.com/authorize",
          token_endpoint: "https://idp.example.com/token",
          jwks_uri: "https://idp.example.com/jwks",
        }),
        finalUrl: "https://idp.example.com/.well-known/openid-configuration",
      }),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe("issuer_mismatch");
    }
  });
});
