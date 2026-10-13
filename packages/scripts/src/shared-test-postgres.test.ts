import { expect, test } from "bun:test";

import { sharedTestDatabase } from "./shared-test-postgres";

test("worktree identities are bounded SQL identifiers and distinguish paths", () => {
  const paths = [
    "/work/a",
    "/work/b",
    "/work/á",
    "/work/a b",
    '/work/a";DROP DATABASE postgres;',
  ];
  const databases = paths.map(sharedTestDatabase);
  expect(new Set(databases).size).toBe(paths.length);
  for (const database of databases) {
    expect(database).toMatch(/^stella_test_[a-f0-9]{24}$/u);
    expect(database.length).toBeLessThan(63);
  }
  expect(sharedTestDatabase("/work/a")).toBe(sharedTestDatabase("/work/a"));
});
