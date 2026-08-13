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
  relativeFile = "packages/example/src/fixture.ts",
): {
  readonly directory: string;
  readonly program: ts.Program;
} => {
  const directory = mkdtempSync(path.join(import.meta.dir, ".result-test-"));
  const file = path.join(directory, relativeFile);
  mkdirSync(path.dirname(file), { recursive: true });
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

const scanFixture = (source: string, relativeFile?: string) => {
  const { directory, program } = createFixtureProgram(source, relativeFile);
  try {
    return scanResultConsumption({ program, repositoryRoot: directory });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

describe("Result consumption guard", () => {
  test("discovers source, root-script, and app-script projects", () => {
    const repositoryRoot = path.resolve(import.meta.dir, "../../..");
    const configs = findResultWorkspaceConfigs(repositoryRoot);

    expect(
      configs.has(path.join(repositoryRoot, "scripts/tsconfig.json")),
    ).toBe(true);
    expect(
      configs.has(path.join(repositoryRoot, "apps/api/tsconfig.json")),
    ).toBe(true);
    expect(
      configs.has(
        path.join(repositoryRoot, "apps/api/scripts/tsconfig.json"),
      ),
    ).toBe(true);
    expect(
      configs.has(path.join(repositoryRoot, "apps/landing/tsconfig.json")),
    ).toBe(true);
    expect(
      configs.has(path.join(repositoryRoot, "apps/web/tsconfig.json")),
    ).toBe(true);
    expect(
      configs.has(path.join(repositoryRoot, "packages/cli/tsconfig.json")),
    ).toBe(true);
  });

  test("detects discarded Results through aliases, wrappers, and chains", () => {
    const diagnostics = scanFixture(`
      import { Result, type Result as BetterResult } from "better-result";

      const parse = (): BetterResult<number, string> => Result.ok(1);
      const parseAlias = parse;
      const parseWrapper = (): BetterResult<number, string> => parseAlias();
      const asyncWrapper = async (): Promise<BetterResult<number, string>> =>
        parseWrapper();
      declare const decoratedResult: () => BetterResult<number, string> & {
        readonly source: "fixture";
      };

      parseAlias();
      parseWrapper();
      asyncWrapper();
      decoratedResult();
      parse().map((value) => value + 1);
      [parse(), decoratedResult()];
      await Promise.all([asyncWrapper(), Promise.resolve(parse())]);
      await Promise.allSettled([asyncWrapper(), Promise.resolve(parse())]);
    `);

    expect(diagnostics.map(({ rule }) => rule)).toEqual([
      "unused-result",
      "unused-result",
      "unused-result",
      "unused-result",
      "unused-result",
      "unused-result",
      "unused-result",
      "unused-result",
      "unused-result",
    ]);
  });

  test("detects Results nested in discarded statement containers", () => {
    const diagnostics = scanFixture(`
      import { Result, type Result as BetterResult } from "better-result";

      const parse = (): BetterResult<number, string> => Result.ok(1);
      const asyncWrapper = async (): Promise<BetterResult<number, string>> =>
        parse();
      declare const consume: (value: unknown) => void;

      ({ direct: parse(), nested: { result: asyncWrapper() }, list: [parse()] });
      (parse(), "statement tail");
      const retainedTail = (parse(), "assigned tail");
      \`discarded interpolation: \${parse()}\`;

      const retainedObject = { result: parse() };
      const retainedTemplate = \`retained interpolation: \${parse()}\`;
      const retainedFinal = (0, parse());
      consume({ result: parse() });
      void retainedTail;
      void retainedObject;
      void retainedTemplate;
      void retainedFinal;
    `);

    expect(diagnostics.map(({ rule }) => rule)).toEqual([
      "unused-result",
      "unused-result",
      "unused-result",
      "unused-result",
      "unused-result",
      "unused-result",
    ]);
  });

  test.each([
    "scripts/fixture.ts",
    "apps/example/scripts/fixture.ts",
    "apps/example/src/fixture.ts",
    "packages/example/src/fixture.ts",
  ])("scans production path %s", (relativeFile) => {
    const diagnostics = scanFixture(
      `
        import { Result, type Result as BetterResult } from "better-result";
        declare const parse: () => BetterResult<number, string>;
        parse();
        void Result;
      `,
      relativeFile,
    );

    expect(diagnostics.map(({ rule }) => rule)).toEqual(["unused-result"]);
  });

  test.each([
    "scripts/fixture.test.ts",
    "scripts/generated/fixture.ts",
    "apps/example/scripts/fixture.gen.ts",
    "apps/example/scripts/node_modules/library/fixture.ts",
    "apps/example/src/__tests__/fixture.ts",
  ])("excludes non-production path %s", (relativeFile) => {
    const diagnostics = scanFixture(
      `
        import { Result, type Result as BetterResult } from "better-result";
        declare const parse: () => BetterResult<number, string>;
        parse();
        void Result;
      `,
      relativeFile,
    );

    expect(diagnostics).toEqual([]);
  });

  test("ignores callee-name and structural Result lookalikes", () => {
    const diagnostics = scanFixture(`
      const Result = {
        gen: (operation: () => unknown): unknown => operation(),
      };
      const safeDb = (operation: () => unknown): unknown => operation();

      class Ok<T> {
        readonly status = "ok" as const;
        constructor(readonly value: T) {}
      }
      class Err<E> {
        readonly status = "error" as const;
        constructor(readonly error: E) {}
      }
      type StructuralResult<T, E> =
        | { readonly status: "ok"; readonly value: T }
        | { readonly status: "error"; readonly error: E };

      const localOk = (): Ok<number> => new Ok(1);
      const localErr = (): Err<string> => new Err("failed");
      const structural = (): StructuralResult<number, string> => ({
        status: "ok",
        value: 1,
      });

      Result.gen(() => 1);
      safeDb(() => 1);
      localOk();
      localErr();
      structural();
      ({ ok: localOk(), err: localErr(), structural: structural() });
      (localOk(), "statement tail");
      \`discarded interpolation: \${structural()}\`;
      [structural(), Promise.resolve(structural())];
      await Promise.all([Promise.resolve(structural())]);
      await Promise.allSettled([Promise.resolve(structural())]);
    `);

    expect(diagnostics).toEqual([]);
  });

  test("requires Better Result provenance and discriminants together", () => {
    const diagnostics = scanFixture(`
      import { Result, type Result as BetterResult } from "better-result";

      type StatusOnly = Pick<BetterResult<number, string>, "status">;
      declare const statusOnly: () => StatusOnly;
      declare const realResult: () => BetterResult<number, string>;

      statusOnly();
      realResult();
      void Result;
    `);

    expect(diagnostics.map(({ rule }) => rule)).toEqual(["unused-result"]);
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
