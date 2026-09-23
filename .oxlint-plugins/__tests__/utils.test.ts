import { describe, expect, test } from "bun:test";

import { canonicalModuleId, isTestFile, moduleMatches } from "../utils.ts";

const IMPORTER = "apps/api/src/lib/entities/query-entities.ts";

describe("canonicalModuleId", () => {
  test("resolves relative specifiers against the importing file", () => {
    expect(canonicalModuleId("../escape-like", IMPORTER)).toBe(
      "apps/api/src/lib/escape-like",
    );
    expect(canonicalModuleId("./filters.ts", IMPORTER)).toBe(
      "apps/api/src/lib/entities/filters",
    );
  });

  test("expands the api alias from any app", () => {
    expect(canonicalModuleId("@/api/lib/escape-like", IMPORTER)).toBe(
      "apps/api/src/lib/escape-like",
    );
    expect(
      canonicalModuleId("@/api/lib/escape-like", "apps/web/src/a.ts"),
    ).toBe("apps/api/src/lib/escape-like");
  });

  test("expands the app-local alias to the importing app", () => {
    expect(canonicalModuleId("@/lib/fetch", "apps/web/src/routes/a.tsx")).toBe(
      "apps/web/src/lib/fetch",
    );
  });

  test("drops a trailing index and leaves packages alone", () => {
    expect(canonicalModuleId("./db/index.ts", IMPORTER)).toBe(
      "apps/api/src/lib/entities/db",
    );
    expect(canonicalModuleId("nanoid/non-secure", IMPORTER)).toBe(
      "nanoid/non-secure",
    );
  });
});

describe("moduleMatches", () => {
  test("accepts an exact id or a predicate", () => {
    expect(moduleMatches("drizzle-orm", "drizzle-orm")).toBe(true);
    expect(moduleMatches("drizzle-orm", "drizzle-orm/pg-core")).toBe(false);
    expect(
      moduleMatches((id) => id.startsWith("nanoid"), "nanoid/non-secure"),
    ).toBe(true);
  });
});

describe("isTestFile", () => {
  test("matches test file names and test directories", () => {
    expect(isTestFile("apps/api/src/a.test.ts")).toBe(true);
    expect(isTestFile("apps/api/src/tests/helpers.ts")).toBe(true);
    expect(isTestFile("packages/x/__tests__/a.ts")).toBe(true);
    expect(isTestFile("apps/api/src/latest/a.ts")).toBe(false);
  });
});
