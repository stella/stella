import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkListing,
  owningPackage,
  type PlaywrightListing,
} from "./check-playwright-config-scope.ts";

const REPO = "/repo";
const WEB = `${REPO}/apps/web`;
const CONFIG = "apps/web/e2e/playwright.config.ts";

const listing = (
  overrides: Partial<PlaywrightListing> = {},
): PlaywrightListing => ({
  config: {
    rootDir: `${WEB}/e2e/specs`,
    projects: [{ name: "chromium", testDir: `${WEB}/e2e/specs` }],
  },
  suites: [{ file: "home.spec.ts", suites: [{ file: "home.spec.ts" }] }],
  errors: [],
  ...overrides,
});

describe("checkListing", () => {
  test("accepts specs inside the owning package", () => {
    expect(checkListing(CONFIG, WEB, listing())).toEqual([]);
  });

  test("accepts a child directory whose name starts with two dots", () => {
    const testDir = `${WEB}/..fixtures`;
    expect(
      checkListing(
        CONFIG,
        WEB,
        listing({
          config: {
            rootDir: testDir,
            projects: [{ name: "chromium", testDir }],
          },
          suites: [{ file: "home.spec.ts" }],
        }),
      ),
    ).toEqual([]);
  });

  test("flags a project whose testDir is another package", () => {
    const problems = checkListing(
      CONFIG,
      WEB,
      listing({
        config: {
          rootDir: `${WEB}/e2e/specs`,
          projects: [
            { name: "chromium", testDir: `${WEB}/e2e/specs` },
            { name: "visual-charts", testDir: `${REPO}/apps/api/e2e` },
          ],
        },
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('project "visual-charts"');
  });

  test("flags a listed spec file outside the package", () => {
    const problems = checkListing(
      CONFIG,
      WEB,
      listing({
        suites: [
          { file: "home.spec.ts" },
          { file: "../../../api/e2e/visual-treemap.spec.ts" },
        ],
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("visual-treemap.spec.ts");
  });

  test("flags a sibling directory sharing the package name prefix", () => {
    const problems = checkListing(
      CONFIG,
      WEB,
      listing({
        config: {
          rootDir: `${WEB}/e2e/specs`,
          projects: [
            { name: "chromium", testDir: `${REPO}/apps/web-next/e2e` },
          ],
        },
      }),
    );
    expect(problems).toHaveLength(1);
  });

  test("flags a spec that fails to load", () => {
    const problems = checkListing(
      CONFIG,
      WEB,
      listing({
        suites: [],
        errors: [
          {
            message:
              "SyntaxError: Cannot use 'import.meta' outside a module\n    at visual-treemap.spec.ts:1",
          },
        ],
      }),
    );
    expect(problems).toEqual([
      `${CONFIG}: failed to load: SyntaxError: Cannot use 'import.meta' outside a module`,
    ]);
  });

  test("flags a config that lists no tests", () => {
    expect(checkListing(CONFIG, WEB, listing({ suites: [] }))).toEqual([
      `${CONFIG}: lists no tests`,
    ]);
  });
});

describe("owningPackage", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("returns the nearest directory with a package.json", () => {
    const root = mkdtempSync(path.join(tmpdir(), "playwright-scope-"));
    roots.push(root);
    mkdirSync(path.join(root, "apps/web/e2e"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), "{}");
    writeFileSync(path.join(root, "apps/web/package.json"), "{}");
    expect(
      owningPackage(path.join(root, "apps/web/e2e/playwright.config.ts")),
    ).toBe(path.join(root, "apps/web"));
  });
});
