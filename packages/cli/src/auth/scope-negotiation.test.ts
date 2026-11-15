import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { negotiateOAuthScopes } from "./scope-negotiation.js";

describe("OAuth scope negotiation", () => {
  test("requests only server-advertised scopes", () => {
    const result = negotiateOAuthScopes({
      advertisedScopes: ["openid", "stella:read"],
      requestedScopes: [
        "openid",
        "offline_access",
        "stella:read",
        "stella:search",
      ],
      requiredScopes: ["openid", "stella:read"],
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual(["openid", "stella:read"]);
    }
  });

  test("keeps old servers without offline_access usable", () => {
    const result = negotiateOAuthScopes({
      advertisedScopes: ["openid", "stella:read", "stella:search"],
      requestedScopes: [
        "openid",
        "offline_access",
        "stella:read",
        "stella:search",
      ],
      requiredScopes: ["openid", "stella:read"],
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).not.toContain("offline_access");
    }
  });

  test("fails before authorization when a required scope is unavailable", () => {
    const result = negotiateOAuthScopes({
      advertisedScopes: ["openid", "stella:read"],
      requestedScopes: ["openid", "stella:admin_write"],
      requiredScopes: ["openid", "stella:admin_write"],
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.missingScopes).toEqual(["stella:admin_write"]);
      expect(result.error.message).toContain("stella:admin_write");
    }
  });

  test("defers to servers whose RFC metadata omits scopes_supported", () => {
    const requestedScopes = ["openid", "offline_access", "stella:read"];
    const result = negotiateOAuthScopes({
      advertisedScopes: undefined,
      requestedScopes,
      requiredScopes: ["openid", "stella:read"],
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual(requestedScopes);
    }
  });

  test("requests an explicitly named server extension scope", () => {
    const result = negotiateOAuthScopes({
      advertisedScopes: ["openid", "stella:read", "stella:server_extension"],
      requestedScopes: ["openid", "stella:server_extension"],
      requiredScopes: ["openid", "stella:server_extension"],
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual(["openid", "stella:server_extension"]);
    }
  });
});
