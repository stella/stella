import { expect, test } from "bun:test";
import path from "node:path";

import {
  runSelectedPackages,
  selectTouchedPackages,
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
  "packages/untyped": { name: "@stll/untyped", scripts: {} },
};

const select = (files: string[]) =>
  selectTouchedPackages(files, (directory) => {
    const manifest = manifests[directory];
    if (manifest === undefined) {
      throw new TypeError(`Unexpected ${directory}`);
    }
    return manifest;
  });

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
