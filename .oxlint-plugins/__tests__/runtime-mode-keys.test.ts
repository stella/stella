import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

// The owner exemption and the env-boundary files are path-scoped, which the
// passive fixture under `.oxlint-plugins/__fixtures__` cannot exercise.
const SOURCE = [
  'import { env as importedEnv } from "node:process";',
  'import { env as bunEnv } from "bun";',
  "const direct = process.env.NODE_ENV;",
  'const computed = process.env["STELLA_LOCAL_DEV"];',
  "const runtimeEnv = process.env;",
  "const aliased = runtimeEnv.NODE_ENV;",
  "const imported = importedEnv.STELLA_LOCAL_DEV;",
  "const { NODE_ENV: destructured } = process.env;",
  "const bun = Bun.env.NODE_ENV;",
  "const { env: { STELLA_LOCAL_DEV: nested } } = process;",
  'const { env: { NODE_ENV: nestedDefault = "x" } = {} } = globalThis.process;',
  "const { env: { STELLA_LOCAL_DEV: bunNested } } = Bun;",
  "let NODE_ENV;",
  "({ NODE_ENV } = process.env);",
  "let STELLA_LOCAL_DEV;",
  "({ env: { STELLA_LOCAL_DEV } } = process);",
  "const { NODE_ENV: fromAlias } = runtimeEnv;",
  "const bunImported = bunEnv.NODE_ENV;",
  "const bunGlobal = globalThis.Bun.env.STELLA_LOCAL_DEV;",
  'const child = { NODE_ENV: "test", STELLA_LOCAL_DEV: "1" };',
  "const { NODE_ENV: fromChild } = child;",
  "const other = process.env.APP_MODE;",
  "const { env: { APP_MODE: otherNested } } = process;",
  "void [direct, computed, aliased, imported, destructured, bun, nested];",
  "void [nestedDefault, bunNested, NODE_ENV, STELLA_LOCAL_DEV, fromAlias];",
  "void [child, fromChild, other, otherNested, bunImported, bunGlobal];",
  "",
].join("\n");

const REPORTED_LINES = [3, 4, 6, 7, 8, 9, 10, 11, 12, 14, 16, 17, 18, 19];

const lint = async (sourcePath: string) =>
  await lintSingleRule("runtime-mode-keys", SOURCE, {
    plugin: "forbid-process-env-outside-env-ts",
    sourcePath,
  });

describe.serial("runtime-mode-keys", () => {
  test("reports every read of the runtime mode keys outside the owner", async () => {
    expect(await lint("apps/api/src/lib/example.ts")).toEqual(REPORTED_LINES);
  });

  test("still reports inside a file the process-env boundary allows", async () => {
    expect(await lint("apps/api/src/env.ts")).toEqual(REPORTED_LINES);
  });

  test("accepts the runtime mode owner", async () => {
    expect(await lint("packages/runtime-mode/src/index.ts")).toEqual([]);
  });
});
