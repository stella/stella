import { describe, expect, test } from "bun:test";
import path from "node:path";

// Repo root, four levels up from this file (packages/property-testing/src).
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * Guard: every test that uses fast-check's `fc.assert` must route its
 * parameters through `propertyConfig` (from this package). That is what wires a
 * property test into the nightly numRuns scaling + CI verbose replay; a raw
 * `fc.assert` silently opts out of both. The nightly job selects property files
 * by their `fc.assert` content, so a missing `propertyConfig` import means a
 * property test that runs at a fixed budget forever. Catch it at the source.
 */
const collectViolations = async (): Promise<string[]> => {
  const glob = new Bun.Glob("{apps,packages}/**/*.test.{ts,tsx}");
  const violations: string[] = [];
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
    if (relativePath.includes("node_modules")) {
      continue;
    }
    const source = await Bun.file(path.resolve(REPO_ROOT, relativePath)).text();
    if (
      source.includes("fc.assert") &&
      !source.includes("@stll/property-testing")
    ) {
      violations.push(relativePath);
    }
  }
  return violations;
};

describe("property-test convention", () => {
  test("every fc.assert test imports propertyConfig", async () => {
    expect(await collectViolations()).toEqual([]);
  });
});
