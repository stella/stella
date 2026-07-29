import { describe, expect, test } from "bun:test";

import {
  buildApiUrl,
  buildVersionedApiUrl,
  STELLA_AUTH_COOKIE_PREFIXES,
  STELLA_API_VERSION_PREFIX,
  STELLA_DEV_AUTH_COOKIE_PREFIX,
  STELLA_MOBILE_ORIGIN,
  STELLA_MOBILE_SCHEME,
  STELLA_REST_API_CONTRACT_VERSION,
} from "./index";

describe("buildApiUrl", () => {
  test("joins unversioned paths with API origins", () => {
    expect(buildApiUrl("https://api.example.com", "/api/auth")).toBe(
      "https://api.example.com/api/auth",
    );
    expect(buildApiUrl("https://api.example.com/", "/mcp")).toBe(
      "https://api.example.com/mcp",
    );
  });
});

describe("REST API contract", () => {
  test("keeps the version prefix and contract number explicit", () => {
    expect(STELLA_API_VERSION_PREFIX).toBe("/v1");
    expect(STELLA_REST_API_CONTRACT_VERSION).toBe(1);
  });

  test("publishes the native auth identity", () => {
    expect(STELLA_MOBILE_SCHEME).toBe("stella");
    expect(STELLA_MOBILE_ORIGIN).toBe("stella://");
    expect(STELLA_AUTH_COOKIE_PREFIXES).toEqual(["better-auth", "stella-dev"]);
    expect(STELLA_DEV_AUTH_COOKIE_PREFIX).toBe("stella-dev");
  });

  test("builds the same URL with or without a trailing origin slash", () => {
    expect(buildVersionedApiUrl("https://api.example.com", "/chat")).toBe(
      "https://api.example.com/v1/chat",
    );
    expect(buildVersionedApiUrl("https://api.example.com/", "/chat")).toBe(
      "https://api.example.com/v1/chat",
    );
  });
});
