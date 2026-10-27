import { describe, expect, test } from "bun:test";

import {
  MOBILE_SCOPES,
  mobileRedirectUri,
} from "@stll/api-contract/mobile-client";

import { buildAuthorizeUrl, readAuthorizationCallback } from "./authorize";
import type { AuthorizationServerMetadata } from "./discovery";

const ISSUER = "https://stella.example.com/api/auth";
const REDIRECT_URI = mobileRedirectUri("preview");

const metadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth2/authorize`,
  token_endpoint: `${ISSUER}/oauth2/token`,
  code_challenge_methods_supported: ["S256"],
} satisfies AuthorizationServerMetadata;

const redirectWith = (
  parameters: Record<string, string>,
  redirectUri = REDIRECT_URI,
) => {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
};

const read = (callbackUrl: string, issuerRequired = false) => {
  const result = readAuthorizationCallback({
    callbackUrl,
    expectedIssuer: ISSUER,
    expectedState: "attempt-state",
    issuerRequired,
    redirectUri: REDIRECT_URI,
  });
  return result.isOk()
    ? { code: result.value }
    : { failure: result.error.failure };
};

describe("authorization request", () => {
  test("asks for an S256 code on the app's redirect with the app's scopes", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client",
        codeChallenge: "challenge",
        metadata,
        redirectUri: REDIRECT_URI,
        resource: "https://stella.example.com/v1",
        state: "attempt-state",
      }),
    );
    expect(url.origin + url.pathname).toBe(metadata.authorization_endpoint);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client",
      redirect_uri: REDIRECT_URI,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "attempt-state",
      resource: "https://stella.example.com/v1",
      scope: MOBILE_SCOPES.join(" "),
      prompt: "consent",
    });
  });
});

describe("authorization callback", () => {
  test("yields the code when the callback answers this attempt", () => {
    expect(
      read(
        redirectWith({ code: "the-code", state: "attempt-state", iss: ISSUER }),
      ),
    ).toEqual({ code: "the-code" });
    expect(
      read(redirectWith({ code: "the-code", state: "attempt-state" })),
    ).toEqual({ code: "the-code" });
  });

  test("refuses a callback for another attempt or another server", () => {
    expect(
      read(redirectWith({ code: "the-code", state: "other-state" })),
    ).toEqual({
      failure: "mismatched",
    });
    expect(read(redirectWith({ code: "the-code" }))).toEqual({
      failure: "mismatched",
    });
    expect(
      read(
        redirectWith({
          code: "the-code",
          state: "attempt-state",
          iss: "https://elsewhere.example.com",
        }),
      ),
    ).toEqual({ failure: "mismatched" });
  });

  test("a server that promises to name its issuer must do so", () => {
    expect(
      read(redirectWith({ code: "the-code", state: "attempt-state" }), true),
    ).toEqual({ failure: "mismatched" });
    expect(
      read(
        redirectWith({ code: "the-code", state: "attempt-state", iss: ISSUER }),
        true,
      ),
    ).toEqual({ code: "the-code" });
  });

  test("an error the server sends back is a refusal, even with a code", () => {
    expect(
      read(
        redirectWith({
          code: "the-code",
          error: "access_denied",
          state: "attempt-state",
        }),
      ),
    ).toEqual({ failure: "denied" });
  });

  test("a callback without a code, or on another redirect, is malformed", () => {
    expect(read(redirectWith({ state: "attempt-state" }))).toEqual({
      failure: "malformed",
    });
    expect(
      read(
        "https://stella.example.com/oauth/callback?code=c&state=attempt-state",
      ),
    ).toEqual({ failure: "malformed" });
    expect(read("not a url")).toEqual({ failure: "malformed" });
    // Another build's redirect answers that build, not this one.
    expect(
      read(
        redirectWith(
          { code: "the-code", state: "attempt-state" },
          mobileRedirectUri("production"),
        ),
      ),
    ).toEqual({ failure: "malformed" });
  });
});
