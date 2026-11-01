import { describe, expect, test } from "bun:test";

import { consentCompletion } from "@/routes/-consent-completion.logic";

describe("consent completion", () => {
  test.each([
    "http://127.0.0.1:4567/callback",
    "http://[::1]:4567/callback",
    "http://localhost:4567/callback",
  ])(
    "returns immediately to the loopback completion screen at %s",
    (target) => {
      const redirectUrl = `${target}?code=grant&state=nonce`;
      const completion = consentCompletion({
        accept: true,
        redirectUrl,
        organizationName: "Novák & Partners",
      });
      expect(completion.status).toBe("redirect");
      const url = new URL(completion.redirectUrl);
      expect(url.origin + url.pathname).toBe(target);
      expect(url.searchParams.get("code")).toBe("grant");
      expect(url.searchParams.get("state")).toBe("nonce");
      expect(url.searchParams.get("organization_name")).toBe(
        "Novák & Partners",
      );
    },
  );

  test.each([
    "https://chatgpt.com/connector/callback?code=grant",
    "https://claude.ai/callback?code=grant",
    "https://localhost.example/callback?code=grant",
    "https://example.com/callback?code=grant",
  ])("keeps the connected screen for %s", (redirectUrl) => {
    expect(
      consentCompletion({
        accept: true,
        redirectUrl,
        organizationName: "Firm",
      }),
    ).toEqual({ status: "connected", redirectUrl });
  });

  test("returns a decline unchanged and does not disclose the organization", () => {
    const redirectUrl = "http://127.0.0.1:4567/callback?error=access_denied";
    expect(
      consentCompletion({
        accept: false,
        redirectUrl,
        organizationName: "Firm",
      }),
    ).toEqual({ status: "redirect", redirectUrl });
  });

  test("omits an unknown organization", () => {
    const redirectUrl = "http://127.0.0.1:4567/callback?code=grant";
    expect(
      consentCompletion({ accept: true, redirectUrl, organizationName: null }),
    ).toEqual({ status: "redirect", redirectUrl });
  });
});
