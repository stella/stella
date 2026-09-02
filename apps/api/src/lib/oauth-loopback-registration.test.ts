import { describe, expect, test } from "bun:test";

import {
  isLoopbackRedirectUri,
  OAUTH_CLIENT_REGISTRATION_PATH,
  resolveLoopbackApplicationType,
  resolveLoopbackClientRegistrationOverride,
} from "@/api/lib/oauth-loopback-registration";

describe("isLoopbackRedirectUri", () => {
  test("accepts the loopback hosts RFC 8252 clients bind to", () => {
    expect(isLoopbackRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(isLoopbackRedirectUri("http://[::1]:33418/callback")).toBe(true);
    expect(isLoopbackRedirectUri("http://localhost:33418/callback")).toBe(true);
  });

  test("rejects anything that is not an http loopback callback", () => {
    expect(isLoopbackRedirectUri("https://app.example.com/callback")).toBe(
      false,
    );
    expect(isLoopbackRedirectUri("http://example.com/callback")).toBe(false);
    // The provider rejects a trailing-dot localhost outright; it must never
    // reach the native branch by way of this default.
    expect(isLoopbackRedirectUri("http://localhost./callback")).toBe(false);
    expect(isLoopbackRedirectUri("https://127.0.0.1:33418/callback")).toBe(
      false,
    );
    expect(isLoopbackRedirectUri("not-a-uri")).toBe(false);
  });
});

describe("resolveLoopbackApplicationType", () => {
  test("defaults an all-loopback registration to native", () => {
    expect(
      resolveLoopbackApplicationType({
        redirect_uris: [
          "http://127.0.0.1:33418/callback",
          "http://[::1]:33418/callback",
          "http://localhost:33418/callback",
        ],
      }),
    ).toBe("native");
  });

  test("leaves a non-loopback host to the provider's https rule", () => {
    expect(
      resolveLoopbackApplicationType({
        redirect_uris: ["https://app.example.com/callback"],
      }),
    ).toBeUndefined();
  });

  test("leaves a mixed redirect list alone", () => {
    expect(
      resolveLoopbackApplicationType({
        redirect_uris: [
          "http://127.0.0.1:33418/callback",
          "https://app.example.com/callback",
        ],
      }),
    ).toBeUndefined();
  });

  test("never overrides a stated application_type", () => {
    for (const applicationType of ["web", "native"]) {
      expect(
        resolveLoopbackApplicationType({
          application_type: applicationType,
          redirect_uris: ["http://127.0.0.1:33418/callback"],
        }),
      ).toBeUndefined();
    }
  });

  test("ignores a body with no usable redirect list", () => {
    expect(resolveLoopbackApplicationType(undefined)).toBeUndefined();
    expect(resolveLoopbackApplicationType({})).toBeUndefined();
    expect(
      resolveLoopbackApplicationType({ redirect_uris: [] }),
    ).toBeUndefined();
    expect(
      resolveLoopbackApplicationType({ redirect_uris: [42] }),
    ).toBeUndefined();
  });
});

describe("resolveLoopbackClientRegistrationOverride", () => {
  test("names only application_type so the rest of the body survives the merge", () => {
    expect(
      resolveLoopbackClientRegistrationOverride({
        body: {
          client_name: "MCP Inspector",
          redirect_uris: ["http://127.0.0.1:6274/oauth/callback"],
        },
        path: OAUTH_CLIENT_REGISTRATION_PATH,
      }),
    ).toEqual({ context: { body: { application_type: "native" } } });
  });

  test("runs on the registration path only", () => {
    expect(
      resolveLoopbackClientRegistrationOverride({
        body: { redirect_uris: ["http://127.0.0.1:6274/oauth/callback"] },
        path: "/oauth2/authorize",
      }),
    ).toBeUndefined();
    expect(
      resolveLoopbackClientRegistrationOverride({
        body: { redirect_uris: ["http://127.0.0.1:6274/oauth/callback"] },
      }),
    ).toBeUndefined();
  });
});
