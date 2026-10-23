import { expect, test } from "bun:test";
import path from "node:path";

import type { CompilerInputStamp } from "./compiler-input-stamp";
import {
  uncoveredCompilerInputs,
  webApiDependencyOutputs,
} from "./web-api-turbo-inputs";

const stamp = (files: readonly string[]): CompilerInputStamp => ({
  context: "fixture",
  contents: Object.fromEntries(files.map((file) => [file, "hash"])),
  installed: {},
  files: { present: [], absent: [] },
  directories: { present: [], absent: [] },
  realpaths: {},
  subdirectories: {},
  listings: [],
});

test("Turbo inputs cover every repository file read by the compiler", () => {
  const root = "/repo";
  const recorded = stamp([
    `${root}/apps/api/src/web-contract.ts`,
    `${root}/packages/money/src/money.ts`,
    `${root}/node_modules/typescript/lib/lib.esnext.d.ts`,
    "/outside/repo/package.json",
  ]);
  const inputs = [
    "$TURBO_ROOT$/apps/api/src/**",
    "$TURBO_ROOT$/packages/{money,time}/**",
  ];

  expect(uncoveredCompilerInputs(recorded, root, inputs, [])).toEqual([]);
  expect(uncoveredCompilerInputs(recorded, root, inputs.slice(1), [])).toEqual([
    "apps/api/src/web-contract.ts",
  ]);
});

test("an excluded compiler input is uncovered even inside an included directory", () => {
  const root = "/repo";
  const recorded = stamp([
    `${root}/apps/api/src/web-contract.ts`,
    `${root}/apps/api/src/routes.ts`,
  ]);
  expect(
    uncoveredCompilerInputs(
      recorded,
      root,
      ["$TURBO_ROOT$/apps/api/src/**", "!$TURBO_ROOT$/apps/api/src/routes.ts"],
      [],
    ),
  ).toEqual(["apps/api/src/routes.ts"]);
});

test("an excluded file a dependency task declares as output stays covered", () => {
  const root = "/repo";
  const recorded = stamp([`${root}/apps/api/src/mcp/generated/catalog.ts`]);
  const inputs = [
    "$TURBO_ROOT$/apps/api/src/**",
    "!$TURBO_ROOT$/apps/api/src/mcp/generated/**",
  ];
  expect(uncoveredCompilerInputs(recorded, root, inputs, [])).toEqual([
    "apps/api/src/mcp/generated/catalog.ts",
  ]);
  expect(
    uncoveredCompilerInputs(recorded, root, inputs, [
      "apps/api/src/mcp/generated/catalog.ts",
    ]),
  ).toEqual([]);
});

test("the API types task's dependency outputs resolve to repository paths", () => {
  const outputs = webApiDependencyOutputs(
    path.resolve(import.meta.dir, "../../../.."),
  );
  expect(outputs).toContain("apps/api/src/mcp/generated/capability-catalog.ts");
  expect(outputs).toContain("apps/web/src/routeTree.gen.ts");
});

test("an exclusion with a wildcard inside the pattern makes its files uncovered", () => {
  const root = "/repo";
  const recorded = stamp([
    `${root}/packages/money/src/money.ts`,
    `${root}/packages/money/dist/index.d.ts`,
  ]);
  expect(
    uncoveredCompilerInputs(
      recorded,
      root,
      ["$TURBO_ROOT$/packages/money/**", "!$TURBO_ROOT$/packages/**/dist/**"],
      [],
    ),
  ).toEqual(["packages/money/dist/index.d.ts"]);
});
