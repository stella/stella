import { expect, test } from "bun:test";
import path from "node:path";

import {
  runSelectedPackages,
  selectTouchedPackages,
  TYPECHECK_BUDGET_EXCLUSIONS,
  validateTypecheckBudgetExclusions,
} from "./pre-push-typecheck";

const manifests: Record<
  string,
  { name: string; scripts: { typecheck?: string } }
> = {
  "apps/web": { name: "@stll/web", scripts: { typecheck: "bun check" } },
  "packages/small": {
    name: "@stll/small",
    scripts: { typecheck: "bun check" },
  },
  "packages/renamed": {
    name: "@stll/renamed",
    scripts: { typecheck: "bun check" },
  },
  "packages/untyped": { name: "@stll/untyped", scripts: {} },
};

const select = (files: string[]) =>
  selectTouchedPackages(
    files,
    (directory) => manifests[directory] !== undefined,
    (directory) => {
      const manifest = manifests[directory];
      if (manifest === undefined) {
        throw new TypeError(`Unexpected ${directory}`);
      }
      return manifest;
    },
  );

test("each changed TypeScript file maps only to its owning package", () => {
  expect(
    select([
      "packages/small/src/a.ts",
      "packages/small/src/b.tsx",
      "apps/web/src/route.ts",
    ]).map(({ name }) => name),
  ).toEqual(["@stll/web", "@stll/small"]);
});

test("root-only and non-TypeScript changes select no packages", () => {
  expect(
    select(["scripts/tool.ts", "package.json", "apps/web/style.css"]),
  ).toEqual([]);
});

test("a deleted TypeScript path still selects its package", () => {
  expect(
    select(["packages/small/src/deleted.ts"]).map(({ name }) => name),
  ).toEqual(["@stll/small"]);
});

test("a deleted package is ignored without reading its removed manifest", () => {
  const reads: string[] = [];
  expect(
    selectTouchedPackages(
      ["packages/removed/src/index.ts"],
      () => false,
      (directory) => {
        reads.push(directory);
        throw new TypeError(`Unexpected manifest read for ${directory}`);
      },
    ),
  ).toEqual([]);
  expect(reads).toEqual([]);
});

test("a renamed package is selected at its new location", () => {
  expect(
    select(["packages/removed/src/index.ts", "packages/renamed/src/index.ts"]),
  ).toEqual([
    {
      directory: "packages/renamed",
      name: "@stll/renamed",
      typecheck: "bun check",
    },
  ]);
});

test("a package without a typecheck script is skipped and named", async () => {
  const packages = select(["packages/untyped/src/index.ts"]);
  expect(packages).toEqual([
    {
      directory: "packages/untyped",
      name: "@stll/untyped",
      typecheck: undefined,
    },
  ]);
  const runs: string[] = [];
  const reports: string[] = [];
  expect(
    await runSelectedPackages(
      packages,
      async ({ name }) => {
        runs.push(name);
        return 0;
      },
      (message) => {
        reports.push(message);
      },
    ),
  ).toBe(0);
  expect(runs).toEqual([]);
  expect(reports).toEqual([
    "pre-push typecheck: skipping @stll/untyped (no typecheck script)",
  ]);
});

test("an over-budget package is skipped while an unlisted package runs", async () => {
  const packages = select([
    "apps/web/src/route.ts",
    "packages/small/src/index.ts",
  ]);
  const runs: string[] = [];
  const reports: string[] = [];

  expect(
    await runSelectedPackages(
      packages,
      async ({ name }) => {
        runs.push(name);
        return 0;
      },
      (message) => {
        reports.push(message);
      },
    ),
  ).toBe(0);
  expect(runs).toEqual(["@stll/small"]);
  expect(reports).toEqual([
    "pre-push-typecheck: @stll/web skipped (75.6 s, 1.14 GB measured; over the pre-push budget); CI checks it",
    "pre-push typecheck: checking @stll/small",
  ]);
});

test("every budget exclusion names a workspace package", () => {
  expect(() =>
    validateTypecheckBudgetExclusions(
      [
        ...TYPECHECK_BUDGET_EXCLUSIONS,
        {
          name: "@stll/unknown",
          measuredTime: "21 s",
          measuredMemory: "401 MB",
        },
      ],
      new Set(["@stll/web", "@stll/small"]),
    ),
  ).toThrow("budget exclusion names unknown package @stll/unknown");
});

test("the real command is an immediate no-op when the range has no changes", () => {
  const result = Bun.spawnSync(
    [
      "bun",
      path.join(import.meta.dirname, "pre-push-typecheck.ts"),
      "--base",
      "HEAD",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
});
