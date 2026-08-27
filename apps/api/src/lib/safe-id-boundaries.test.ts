import { describe, expect, test } from "bun:test";

import {
  AUTH_GENERATED_ID_PATTERN,
  parseExternalOrganizationId,
} from "@/api/lib/safe-id-boundaries";

// Better Auth's default generator mints 32 characters of base62 text, which
// is not a UUID and must survive every check that reads one of its ids.
const AUTH_GENERATED_ID = "AuthGeneratedIdAuthGeneratedId12";

describe("auth-generated id pattern", () => {
  test("accepts the opaque text Better Auth mints", () => {
    expect(AUTH_GENERATED_ID_PATTERN.test(AUTH_GENERATED_ID)).toBe(true);
  });

  test("accepts UUID ids, which self-hosted generators may still produce", () => {
    expect(
      AUTH_GENERATED_ID_PATTERN.test("0191d14d-9a63-7d2e-a021-06053e542c85"),
    ).toBe(true);
  });

  test("rejects separators that could smuggle a second identifier", () => {
    expect(AUTH_GENERATED_ID_PATTERN.test("not/an/id")).toBe(false);
    expect(AUTH_GENERATED_ID_PATTERN.test("")).toBe(false);
  });
});

describe("external organization id parsing", () => {
  test("accepts UUID organization ids", () => {
    expect(
      String(
        parseExternalOrganizationId("0191d14d-9a63-7d2e-a021-06053e542c85"),
      ),
    ).toBe("0191d14d-9a63-7d2e-a021-06053e542c85");
  });

  test("accepts auth-generated organization ids", () => {
    expect(String(parseExternalOrganizationId(AUTH_GENERATED_ID))).toBe(
      AUTH_GENERATED_ID,
    );
  });

  test("rejects malformed provider metadata before database access", () => {
    expect(parseExternalOrganizationId("not/an/organization/id")).toBeNull();
  });
});
