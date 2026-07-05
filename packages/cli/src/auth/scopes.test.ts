import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { parseScopesFlag } from "./scopes.js";

describe("parseScopesFlag", () => {
  test("splits a comma-separated list", () => {
    const result = parseScopesFlag("openid,profile,stella:read");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual(["openid", "profile", "stella:read"]);
    }
  });

  test("trims whitespace around each scope and drops empty entries", () => {
    const result = parseScopesFlag(" openid , , stella:read ");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual(["openid", "stella:read"]);
    }
  });

  test("rejects an entirely empty value", () => {
    expect(Result.isError(parseScopesFlag(""))).toBe(true);
    expect(Result.isError(parseScopesFlag(" , , "))).toBe(true);
  });

  test("rejects a scope token containing internal whitespace", () => {
    const result = parseScopesFlag("openid,stella read");
    expect(Result.isError(result)).toBe(true);
  });
});
