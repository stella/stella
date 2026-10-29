import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { sha256Base64Url as legacyBase64Url } from "@stll/sha256/node";

import type { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import { delegatedReadScopes } from "@/api/lib/auth/microsoft365/capabilities";
import {
  buildAuthorizeUrl,
  createPkce,
  refreshSharepointAccessToken,
} from "@/api/lib/auth/microsoft365/graph-oauth";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { SafeOutboundFetchError } from "@/api/lib/safe-outbound-fetch";
import { secretSchema } from "@/api/lib/secret-brands";

describe("buildAuthorizeUrl", () => {
  test("carries the OAuth and PKCE parameters", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client-123",
        tenantId: "tenant-abc",
        codeChallenge: "challenge",
        redirectUri: "https://api.example.com/v1/sharepoint/oauth/callback",
        state: "state-xyz",
      }),
    );

    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe("/tenant-abc/oauth2/v2.0/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("scope")).toBe(
      "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Sites.Read.All",
    );
  });

  test("threads a calendar-only consent request into the authorize URL", () => {
    const scope = delegatedReadScopes(["calendar.read"]);
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client-123",
        tenantId: "tenant-abc",
        codeChallenge: "challenge",
        redirectUri: "https://api.example.com/v1/sharepoint/oauth/callback",
        scope,
        state: "state-xyz",
      }),
    );
    expect(url.searchParams.get("scope")).toBe(scope);
    expect(url.searchParams.get("scope")).not.toContain("Files.Read.All");
  });
});

test("SharePoint PKCE preserves the legacy unpadded base64url digest", () => {
  const { codeVerifier, codeChallenge } = createPkce();
  expect(codeChallenge).toBe(legacyBase64Url(codeVerifier));
});

test("refresh requests only the reviewed scopes through bounded outbound transport", async () => {
  const scope = delegatedReadScopes(["calendar.read"]);
  const fetchBytes: typeof safeOutboundFetchBytes = async (input) => {
    expect(new URL(input.url).hostname).toBe("login.microsoftonline.com");
    expect(input.method).toBe("POST");
    expect(input.maxBytes).toBe(64 * 1024);
    expect(input.timeoutMs).toBe(10_000);
    expect(input.redirect).toBe("error");
    expect(input.body).toBeInstanceOf(URLSearchParams);
    if (!(input.body instanceof URLSearchParams)) {
      return panic("Expected URL-encoded token request");
    }
    expect(input.body.get("grant_type")).toBe("refresh_token");
    expect(input.body.get("scope")).toBe(scope);
    return Result.ok({
      body: new TextEncoder().encode(
        JSON.stringify({ access_token: "access-token" }),
      ).buffer,
      headers: new Headers(),
      ok: true,
      status: 200,
    });
  };
  const result = await refreshSharepointAccessToken({
    clientId: "client-123",
    clientSecret: "client-secret",
    fetchBytes,
    permit: grantThirdPartyOutboundPermit(),
    refreshToken: v.parse(secretSchema, "refresh-token"),
    scope,
    tenantId: "tenant-abc",
  });
  expect(Result.isOk(result) && result.value.access_token).toBe("access-token");
});

test("invalid token responses exclude provider secrets from error causes", async () => {
  const privateText = "private-refresh-token";
  for (const body of [
    `{"refresh_token":"${privateText}"`,
    JSON.stringify({ access_token: 123, refresh_token: privateText }),
  ]) {
    const result = await refreshSharepointAccessToken({
      clientId: "client-123",
      clientSecret: "client-secret",
      permit: grantThirdPartyOutboundPermit(),
      refreshToken: v.parse(secretSchema, "refresh-token"),
      scope: delegatedReadScopes(["calendar.read"]),
      tenantId: "tenant-abc",
      fetchBytes: async () =>
        Result.ok({
          body: new TextEncoder().encode(body).buffer,
          headers: new Headers(),
          ok: true,
          status: 200,
        }),
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toBe("Invalid Microsoft token response");
      expect(JSON.stringify(result.error)).not.toContain(privateText);
    }
  }
});

test("token refusals and rejected transports retain their 502 classification", async () => {
  const cases = [
    {
      message: "Microsoft token endpoint returned HTTP 401",
      fetchBytes: async () =>
        Result.ok({
          body: new ArrayBuffer(0),
          headers: new Headers(),
          ok: false,
          status: 401,
        }),
    },
    {
      message: "Failed to reach the Microsoft token endpoint",
      fetchBytes: async () =>
        Result.err(
          new SafeOutboundFetchError({ message: "private provider detail" }),
        ),
    },
    {
      message: "Provider refusal",
      fetchBytes: async () => {
        throw new HandlerError({ status: 403, message: "Provider refusal" });
      },
    },
  ] satisfies { message: string; fetchBytes: typeof safeOutboundFetchBytes }[];
  for (const { message, fetchBytes } of cases) {
    const result = await refreshSharepointAccessToken({
      clientId: "client",
      clientSecret: "secret",
      fetchBytes,
      permit: grantThirdPartyOutboundPermit(),
      refreshToken: v.parse(secretSchema, "refresh-token"),
      scope: delegatedReadScopes(["calendar.read"]),
      tenantId: "tenant",
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 502,
        code: "internal_error",
        message,
      });
    }
  }
});
