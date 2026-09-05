import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CLI_DEFAULT_RESOURCE_SCOPES,
  CLI_NON_DEFAULT_RESOURCE_SCOPES,
  CLI_REQUIRED_RESOURCE_SCOPES,
} from "./constants.js";
import { parseScopesFlag } from "./scopes.js";

describe("parseScopesFlag", () => {
  test("splits a comma-separated list", () => {
    const result = parseScopesFlag("stella:read,stella:search");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual(["stella:read", "stella:search"]);
    }
  });

  test("trims whitespace around each scope and drops empty entries", () => {
    const result = parseScopesFlag(" stella:read , , stella:search ");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual(["stella:read", "stella:search"]);
    }
  });

  // The flag used to accept identity scopes, which meant a user following the
  // CLI's own missing-scope hint dropped `offline_access` and lost their
  // refresh token. Identity scopes are the CLI's business, not the flag's.
  test("rejects identity scopes and names every rejected entry", () => {
    const result = parseScopesFlag("openid,stella:read,offline_access");
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("openid");
      expect(result.error.message).toContain("offline_access");
      expect(result.error.message).not.toContain("stella:read,");
    }
  });

  test("rejects any scope outside the stella: namespace", () => {
    expect(Result.isError(parseScopesFlag("read"))).toBe(true);
    expect(Result.isError(parseScopesFlag("stella:read,admin"))).toBe(true);
  });

  test("rejects an entirely empty value", () => {
    expect(Result.isError(parseScopesFlag(""))).toBe(true);
    expect(Result.isError(parseScopesFlag(" , , "))).toBe(true);
  });

  test("rejects a scope token containing internal whitespace", () => {
    const result = parseScopesFlag("stella:read,stella read");
    expect(Result.isError(result)).toBe(true);
  });
});

describe("default login scopes", () => {
  test("every catalog scope is either requested by default or deliberately left out", () => {
    const classified = new Set<string>([
      ...CLI_DEFAULT_RESOURCE_SCOPES,
      ...CLI_NON_DEFAULT_RESOURCE_SCOPES,
    ]);
    expect(
      CLI_REQUIRED_RESOURCE_SCOPES.filter((scope) => !classified.has(scope)),
    ).toEqual([]);
    expect(
      CLI_DEFAULT_RESOURCE_SCOPES.filter((scope) =>
        (CLI_NON_DEFAULT_RESOURCE_SCOPES as readonly string[]).includes(scope),
      ),
    ).toEqual([]);
  });
});
