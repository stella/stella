import { describe, expect, test } from "bun:test";

import type { ConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import { queryView } from "@/lib/query-view.logic";
import {
  consentCompletion,
  isConsentAllowDisabled,
} from "@/routes/-consent-completion.logic";

const stellaCli: ConsentClientIdentity = {
  type: "verified",
  brand: "stella_cli",
  name: "stella CLI",
  publisher: "stella",
};

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
        client: stellaCli,
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
        client: stellaCli,
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
        client: stellaCli,
        organizationName: "Firm",
      }),
    ).toEqual({ status: "redirect", redirectUrl });
  });

  test.each<ConsentClientIdentity>([
    {
      type: "verified",
      brand: "claude_code",
      name: "Claude Code",
      publisher: "Anthropic",
    },
    { type: "verified", brand: "codex", name: "Codex", publisher: "OpenAI" },
    { type: "verified_unbranded", name: "Desktop tool" },
    { type: "unverified", name: "stella CLI" },
    { type: "unknown", name: "App" },
  ])(
    "does not disclose the organization to another loopback client ($name)",
    (client) => {
      const redirectUrl = "http://127.0.0.1:4567/callback?code=grant";
      const completion = consentCompletion({
        accept: true,
        redirectUrl,
        client,
        organizationName: "Firm",
      });
      expect(completion.status).toBe("redirect");
      const url = new URL(completion.redirectUrl);
      expect(url.searchParams.get("code")).toBe("grant");
      expect(url.searchParams.has("organization_name")).toBe(false);
    },
  );

  test("omits an unknown organization", () => {
    const redirectUrl = "http://127.0.0.1:4567/callback?code=grant";
    expect(
      consentCompletion({
        accept: true,
        redirectUrl,
        client: stellaCli,
        organizationName: null,
      }),
    ).toEqual({ status: "redirect", redirectUrl });
  });
});

describe("consent Allow", () => {
  const sessionReadError = new Error("Session read failed");
  const refetch = async () => {
    throw sessionReadError;
  };
  const previousSession = { session: { activeOrganizationId: "org-previous" } };
  const currentSession = queryView({
    status: "success",
    fetchStatus: "idle",
    data: previousSession,
    error: null,
    isPlaceholderData: false,
    refetch,
  });

  test("is enabled with client details and a current session read", () => {
    expect(
      isConsentAllowDisabled({
        clientInfoFailed: false,
        clientInfoLoaded: true,
        session: currentSession,
      }),
    ).toBe(false);
  });

  test("stays disabled when the session refetch after an organization switch fails", () => {
    // The cached session still names the previous organization, so the page
    // would show it while the server binds the grant to the new one.
    const staleSession = queryView({
      status: "error",
      fetchStatus: "idle",
      data: previousSession,
      error: sessionReadError,
      isPlaceholderData: false,
      refetch,
    });
    expect(staleSession.type).toBe("items");
    expect(
      isConsentAllowDisabled({
        clientInfoFailed: false,
        clientInfoLoaded: true,
        session: staleSession,
      }),
    ).toBe(true);
  });

  test("stays disabled when the session cannot be read", () => {
    const failedSession = queryView({
      status: "error",
      fetchStatus: "idle",
      data: undefined,
      error: sessionReadError,
      isPlaceholderData: false,
      refetch,
    });
    expect(
      isConsentAllowDisabled({
        clientInfoFailed: false,
        clientInfoLoaded: true,
        session: failedSession,
      }),
    ).toBe(true);
  });

  test("stays disabled until the client details load", () => {
    expect(
      isConsentAllowDisabled({
        clientInfoFailed: false,
        clientInfoLoaded: false,
        session: currentSession,
      }),
    ).toBe(true);
    expect(
      isConsentAllowDisabled({
        clientInfoFailed: true,
        clientInfoLoaded: false,
        session: currentSession,
      }),
    ).toBe(true);
  });
});
