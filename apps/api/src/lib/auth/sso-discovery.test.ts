import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  deriveDiscoveryEndpoint,
  probeOidcDiscovery,
} from "@/api/lib/auth/sso-discovery";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

const okJsonBody = (value: unknown): ArrayBuffer => {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  );
};

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
      fetchBytes: async () =>
        Result.ok({
          status: 200,
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          body: okJsonBody({
            issuer: "https://idp.example.com/",
            authorization_endpoint: "https://idp.example.com/authorize",
            token_endpoint: "https://idp.example.com/token",
            jwks_uri: "https://idp.example.com/jwks",
          }),
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
      fetchBytes: async () =>
        Result.ok({
          status: 200,
          ok: true,
          headers: new Headers(),
          body: okJsonBody({
            issuer: "https://evil.example.com",
            authorization_endpoint: "https://idp.example.com/authorize",
            token_endpoint: "https://idp.example.com/token",
            jwks_uri: "https://idp.example.com/jwks",
          }),
        }),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe("issuer_mismatch");
    }
  });
});
