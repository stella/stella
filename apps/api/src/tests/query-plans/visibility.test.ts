import { describe, expect, test } from "bun:test";
import path from "node:path";

const API_SOURCE = path.resolve(import.meta.dir, "../..");

/**
 * A heap-fetch count is visibility-map state, so a test asserting one must
 * first establish that every page is all-visible, through the helper that
 * waits for concurrent snapshots and names them when they outlast it.
 */
describe("heap-fetch assertions", () => {
  test("establish all-visible pages through vacuumUntilAllVisible", async () => {
    const asserting: string[] = [];
    const violations: string[] = [];
    for await (const file of new Bun.Glob("**/*.test.ts").scan({
      cwd: API_SOURCE,
    })) {
      const absolute = path.join(API_SOURCE, file);
      if (absolute === import.meta.path) {
        continue;
      }
      const source = await Bun.file(absolute).text();
      if (!source.includes("Heap Fetches")) {
        continue;
      }
      asserting.push(file);
      if (!source.includes("vacuumUntilAllVisible(")) {
        violations.push(`${file}: no vacuumUntilAllVisible call`);
      }
      if (/\bVACUUM\b/u.test(source)) {
        violations.push(`${file}: runs VACUUM directly`);
      }
    }
    expect(asserting).toContain(
      "handlers/case-law/decisions/court-vocabulary-plan.postgres.test.ts",
    );
    expect(violations).toEqual([]);
  });
});
