import { describe, expect, test } from "bun:test";

import { buildCallbackRedirectUrl } from "@/api/handlers/mcp-connectors/oauth-callback";

describe("buildCallbackRedirectUrl", () => {
  test("encodes a connected slug onto the SPA terminal route", () => {
    const url = buildCallbackRedirectUrl("https://my.stll.app", {
      status: "connected",
      slug: "linear",
    });

    expect(url).toBe(
      "https://my.stll.app/mcp/oauth-callback?status=connected&slug=linear",
    );
  });

  test("encodes an error reason onto the SPA terminal route", () => {
    const url = buildCallbackRedirectUrl("https://my.stll.app", {
      status: "error",
      reason: "expired-state",
    });

    expect(url).toBe(
      "https://my.stll.app/mcp/oauth-callback?status=error&reason=expired-state",
    );
  });

  test("percent-encodes slugs that contain whitespace", () => {
    const url = buildCallbackRedirectUrl("https://example.test/", {
      status: "connected",
      slug: "with space",
    });

    expect(url).toBe(
      "https://example.test/mcp/oauth-callback?status=connected&slug=with+space",
    );
  });
});
