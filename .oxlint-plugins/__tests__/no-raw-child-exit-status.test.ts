import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(30_000);

const lint = async (source: string, sourcePath = "scripts/example.ts") =>
  await lintSingleRule("no-raw-child-exit-status", source, { sourcePath });

describe("child termination normalization", () => {
  test("rejects numeric coercion of raw statuses but permits normalized arithmetic and literal comparisons", async () => {
    expect(
      await lint(
        [
          'import { childExitStatus } from "../packages/scripts/src/child-exit-status";',
          'const child = Bun.spawnSync(["tool"]);',
          "process.exit(child.exitCode + 0);",
          "process.exit(+child.exitCode);",
          "process.exitCode = child.exitCode | 0;",
          "process.exit(0 - child.exitCode);",
          "process.exit(~child.exitCode);",
          "process.exit((child.exitCode ?? 0) * 1);",
          "process.exit(childExitStatus(child) + 0);",
          "process.exit(+childExitStatus(child));",
          "process.exit(child.exitCode === 0 ? 0 : 1);",
          "process.exit(child.exitCode > 0 ? 1 : 0);",
        ].join("\n"),
      ),
    ).toEqual([3, 4, 5, 6, 7, 8]);
  });
  test("recognizes imported Bun spawns and aliases of the spawn primitive", async () => {
    expect(
      await lint(
        [
          'import { spawnSync as run } from "bun";',
          'const result = run(["tool"]);',
          "process.exit(result.exitCode);",
          "const spawn = Bun.spawn;",
          'const child = spawn(["tool"]);',
          "process.exit(await child.exited);",
        ].join("\n"),
      ),
    ).toEqual([3, 6]);
  });
  test("follows locally sourced wrapper parameters and aliases without banning safe callers", async () => {
    expect(
      await lint(
        [
          'import { childExitStatus } from "../packages/scripts/src/child-exit-status";',
          'const child = Bun.spawn(["tool"]);',
          "const finish = (code: number) => process.exit(code);",
          "const alias = finish;",
          "alias(child.exitCode);",
          "function done(code: number) { process.exitCode = code; }",
          "done(await child.exited);",
          "const clean = (code: number) => process.exit(code);",
          "clean(childExitStatus(child));",
          "clean(0);",
          "function opaque(code: number) { process.exit(code); }",
        ].join("\n"),
      ),
    ).toEqual([3, 6]);
  });
  test("retains Bun shell result provenance and resolves namespace helper imports", async () => {
    expect(
      await lint(
        [
          'import { $ } from "bun";',
          'import * as status from "../packages/scripts/src/child-exit-status";',
          "const result = await $`tool`.nothrow();",
          "process.exit(result.exitCode);",
          "process.exit(status.childExitStatus(result));",
          "const { childExitStatus: normalize } = status;",
          "process.exit(normalize(result));",
        ].join("\n"),
      ),
    ).toEqual([4]);
  });
  test("rejects raw status properties, computed properties and exit assignments", async () => {
    expect(
      await lint(
        [
          'import { spawnSync } from "node:child_process";',
          'const child = Bun.spawn(["tool"]);',
          'const sync = spawnSync("tool");',
          "process.exit(child.exitCode);",
          'process["exit"](await child["exited"]);',
          "process.exit(sync.status ?? 0);",
          "process.exitCode = sync.status;",
          'process["exitCode"] = flag ? 0 : child.exitCode;',
          "process.exit(Math.max(child.exitCode, 1));",
        ].join("\n"),
      ),
    ).toEqual([4, 5, 6, 7, 8, 9]);
  });

  test("follows aliases, destructuring, awaited Promise.all and local returns", async () => {
    expect(
      await lint(
        [
          'const child = Bun.spawn(["tool"]);',
          "const result = child;",
          "const { exitCode: status } = result;",
          "const alias = status;",
          "process.exit(alias);",
          "const [code] = await Promise.all([child.exited]);",
          "process.exit(code);",
          "const run = async () => await child.exited;",
          "process.exit(await run());",
          "function outcome() { return child.exitCode; }",
          "process.exit(outcome());",
        ].join("\n"),
      ),
    ).toEqual([5, 7, 9, 11]);
  });

  test("resolves process import and method aliases without capturing shadowed globals", async () => {
    expect(
      await lint(
        [
          'import proc, { exit as quit } from "node:process";',
          'const child = Bun.spawn(["tool"]);',
          "const p = proc;",
          "const { exit: stop } = p;",
          "stop(child.exitCode);",
          "quit(child.exitCode);",
          "const halt = process.exit;",
          "halt(child.exitCode);",
          "function unrelated(process: { exit: (code: unknown) => void }) { process.exit(child.exitCode); }",
        ].join("\n"),
      ),
    ).toEqual([5, 6, 8]);
  });

  test("recognizes only the imported canonical helper and its lexical aliases", async () => {
    expect(
      await lint(
        [
          'import { childExitStatus as normalize } from "../packages/scripts/src/child-exit-status";',
          'import { childExitStatus as foreign } from "other-package";',
          'const child = Bun.spawn(["tool"]);',
          "const safe = normalize;",
          "process.exit(safe(child));",
          "process.exit(foreign(child.exitCode));",
          "function shadow(normalize: (code: unknown) => number) { process.exit(normalize(child.exitCode)); }",
          "process.exitCode = normalize(child);",
          "const run = () => normalize(child);",
          "process.exit(run());",
          "process.exit(foreign(child));",
          "function shadowObject(normalize: (code: unknown) => number) { process.exit(normalize(child)); }",
          "const wrapper = (code: number) => normalize(code);",
          "process.exit(wrapper(child.exitCode));",
        ].join("\n"),
      ),
    ).toEqual([6, 7, 11, 12]);
    expect(
      await lint(
        [
          'import { childExitStatus as normalize } from "@stll/scripts/src/child-exit-status";',
          'import * as status from "@stll/scripts/src/child-exit-status";',
          'import { childExitStatus as foreign } from "@stll/scripts/src/child-exit-status-other";',
          'const child = Bun.spawn(["tool"]);',
          "process.exit(normalize(child));",
          "process.exit(status.childExitStatus(child));",
          "const { childExitStatus: safe } = status;",
          "const alias = safe;",
          "process.exitCode = alias(child);",
          "process.exit(child.exitCode);",
          "process.exit(foreign(child));",
        ].join("\n"),
      ),
    ).toEqual([10, 11]);
    expect(
      await lint(
        'import { childExitStatus } from "./child-exit-status"; const child = Bun.spawn(["tool"]); process.exit(childExitStatus(child));',
        "packages/scripts/src/example.ts",
      ),
    ).toEqual([]);
  });

  test("allows literal outcomes, domain statuses and unproven parameters", async () => {
    expect(
      await lint(
        [
          'const report = { exitCode: 0, status: "complete" };',
          "process.exit(report.exitCode);",
          'process.exit(report.status === "complete" ? 0 : 1);',
          'const child = Bun.spawn(["tool"]);',
          "process.exit(child.exitCode === 0 ? 0 : 1);",
          "process.exit(0);",
          "function finish(exitCode: number) { process.exit(exitCode); }",
          "process.exit(main());",
          "function main() { return 0; }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("exempts only the helper owner and respects shadowed Bun", async () => {
    const raw =
      'const child = Bun.spawn(["tool"]); process.exit(child.exitCode);';
    expect(
      await lint(raw, "packages/scripts/src/child-exit-status.ts"),
    ).toEqual([]);
    expect(
      await lint(raw, "packages/scripts/src/child-exit-status-other.ts"),
    ).toEqual([1]);
    expect(
      await lint(
        "function local(Bun: { spawn: () => { exitCode: number } }) { const child = Bun.spawn(); process.exit(child.exitCode); }",
      ),
    ).toEqual([]);
  });
});
