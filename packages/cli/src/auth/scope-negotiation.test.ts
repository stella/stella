import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { negotiateOAuthScopes } from "./scope-negotiation.js";

describe("OAuth scope negotiation", () => {
  test("uses only server-advertised authorization and registration scopes", () => {
    const result = negotiateOAuthScopes({
      advertisedScopes: ["openid", "stella:read"],
      registrationScopes: [
        "openid",
        "offline_access",
        "stella:read",
        "stella:admin_write",
      ],
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
      expect(result.value).toEqual({
        registrationScopes: ["openid", "stella:read"],
        requestedScopes: ["openid", "stella:read"],
      });
    }
  });

  test("keeps old servers without offline_access usable", () => {
    const result = negotiateOAuthScopes({
      advertisedScopes: ["openid", "stella:read", "stella:search"],
      registrationScopes: [
        "openid",
        "offline_access",
        "stella:read",
        "stella:search",
      ],
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
      expect(result.value.requestedScopes).not.toContain("offline_access");
      expect(result.value.registrationScopes).not.toContain("offline_access");
    }
  });

  test("fails before authorization when a required scope is unavailable", () => {
    const result = negotiateOAuthScopes({
      advertisedScopes: ["openid", "stella:read"],
      registrationScopes: ["openid", "stella:read", "stella:admin_write"],
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
    const registrationScopes = [
      "openid",
      "offline_access",
      "stella:read",
      "stella:admin_write",
    ];
    const result = negotiateOAuthScopes({
      advertisedScopes: undefined,
      registrationScopes,
      requestedScopes,
      requiredScopes: ["openid", "stella:read"],
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual({ registrationScopes, requestedScopes });
    }
  });

  test("registers an explicitly requested server extension scope", () => {
    const result = negotiateOAuthScopes({
      advertisedScopes: ["openid", "stella:read", "stella:server_extension"],
      registrationScopes: ["openid", "stella:read"],
      requestedScopes: ["openid", "stella:server_extension"],
      requiredScopes: ["openid", "stella:server_extension"],
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.registrationScopes).toEqual([
        "openid",
        "stella:read",
        "stella:server_extension",
      ]);
    }
  });
});
