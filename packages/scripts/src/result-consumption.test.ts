import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  findResultWorkspaceConfigs,
  scanResultConsumption,
} from "./result-consumption";

const createFixtureProgram = (
  source: string,
): {
  readonly directory: string;
  readonly program: ts.Program;
} => {
  const directory = mkdtempSync(path.join(import.meta.dir, ".result-test-"));
  const sourceDirectory = path.join(directory, "src");
  mkdirSync(sourceDirectory);
  const file = path.join(sourceDirectory, "fixture.ts");
  writeFileSync(file, source);

  return {
    directory,
    program: ts.createProgram({
      rootNames: [file],
      options: {
        module: ts.ModuleKind.Preserve,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ESNext,
      },
    }),
  };
};

const scanFixture = (source: string) => {
  const { directory, program } = createFixtureProgram(source);
  try {
    return scanResultConsumption({ program, repositoryRoot: directory });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

describe("Result consumption guard", () => {
  test("discovers workspaces that import Result", () => {
    const repositoryRoot = path.resolve(import.meta.dir, "../../..");
    const configs = findResultWorkspaceConfigs(repositoryRoot);

    expect(
      configs.has(path.join(repositoryRoot, "apps/api/tsconfig.json")),
    ).toBe(true);
    expect(
      configs.has(path.join(repositoryRoot, "apps/web/tsconfig.json")),
    ).toBe(true);
    expect(
      configs.has(path.join(repositoryRoot, "packages/cli/tsconfig.json")),
    ).toBe(true);
  });

  test("detects discarded Results through helper aliases and chains", () => {
    const diagnostics = scanFixture(`
      import { Result, type Result as BetterResult } from "better-result";

      const parse = (): BetterResult<number, string> => Result.ok(1);

      parse();
      parse().map((value) => value + 1);
    `);

    expect(diagnostics.map(({ rule }) => rule)).toEqual([
      "unused-result",
      "unused-result",
    ]);
  });

  test("detects discarded awaited and nullable Results", () => {
    const diagnostics = scanFixture(`
      import { Result, type Result as BetterResult } from "better-result";

      const load = async (): Promise<BetterResult<number, string>> => Result.ok(1);
      const optional = (): BetterResult<number, string> | undefined => Result.ok(1);

      async function run() {
        await load();
        optional();
      }
      void run;
    `);

    expect(diagnostics.map(({ rule }) => rule)).toEqual([
      "unused-result",
      "unused-result",
    ]);
  });

  test("accepts Results that are returned, assigned, or matched", () => {
    const diagnostics = scanFixture(`
      import { Result, type Result as BetterResult } from "better-result";

      const parse = (): BetterResult<number, string> => Result.ok(1);
      let assigned = parse();
      assigned = parse();
      const forwarded = (): BetterResult<number, string> => parse();
      parse().match({ ok: () => undefined, err: () => undefined });
    `);

    expect(diagnostics).toEqual([]);
  });

  test("requires invariant messages only on better-result unwrap calls", () => {
    const diagnostics = scanFixture(`
      import { Result, type Result as BetterResult } from "better-result";

      const parse = (): BetterResult<number, string> => Result.ok(1);
      parse().unwrap();
      Result.unwrap(parse());
      const message = "dynamic messages hide the invariant at the call site";
      parse().unwrap(message);
      parse().unwrap("parser result was checked above");
      Result.unwrap(parse(), "parser result was checked above");

      const unrelated = { unwrap: () => 1 };
      unrelated.unwrap();
    `);

    expect(diagnostics.map(({ rule }) => rule)).toEqual([
      "result-unwrap-requires-message",
      "result-unwrap-requires-message",
      "result-unwrap-requires-message",
    ]);
  });
});
