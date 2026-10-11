import { describe, expect, test } from "bun:test";

import type { OAuthConsentInfo } from "@/lib/oauth-provider";
import { classifyOAuthDestination } from "@/routes/consent/-components/oauth-destination.logic";

const info = (redirectHosts: string[]): OAuthConsentInfo => ({
  client_name: "Example app",
  redirectHosts,
  clientIdHost: null,
  unverified: false,
  verifiedBrand: null,
});

describe("OAuth destination classification", () => {
  test("uses the selected redirect when registered hosts mix local and hosted destinations", () => {
    const consentInfo = info(["localhost:3000", "app.example"]);

    expect(
      classifyOAuthDestination(consentInfo, "http://localhost:3000/callback"),
    ).toBe("loopback");
    expect(
      classifyOAuthDestination(consentInfo, "https://app.example/callback"),
    ).toBe("hosted");
  });

  test.each([
    "http://localhost:3000/callback",
    "http://127.0.0.1:5000/callback",
    "http://127.12.34.56:5000/callback",
    "http://[::1]:8080/callback",
  ])("accepts loopback redirect %s", (redirectUri) => {
    expect(classifyOAuthDestination(info(["app.example"]), redirectUri)).toBe(
      "loopback",
    );
  });

  test.each([
    "http://localhost.evil/callback",
    "http://127.evil/callback",
    "not a URL",
    "http://127.0.0.999/callback",
    "",
  ])(
    "does not treat invalid or deceptive redirect %s as loopback",
    (redirectUri) => {
      expect(
        classifyOAuthDestination(info(["localhost:3000"]), redirectUri),
      ).toBe("hosted");
    },
  );
});
