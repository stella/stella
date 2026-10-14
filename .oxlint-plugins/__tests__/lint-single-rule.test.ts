import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  lintSingleRule,
  lintsAlone,
  runSingleRule,
  sharedLines,
} from "./lint-single-rule.ts";

const CODE = "plugin(rule)";
const FILES = ["/scratch/a/source.ts", "/scratch/b/source.ts"];

const sharedReport = (lines: readonly [string, number][]) =>
  JSON.stringify({
    diagnostics: lines.map(([filename, line]) => ({
      code: CODE,
      filename,
      labels: [{ span: { line } }],
    })),
    number_of_files: FILES.length,
    number_of_rules: 1,
  });

test("a shared run without reports is clean only when oxlint exits 0", () => {
  const stdout = sharedReport([]);
  expect(sharedLines({ stdout, stderr: "", exitCode: 2 }, FILES, CODE)).toBe(
    null,
  );
  expect(sharedLines({ stdout, stderr: "", exitCode: 1 }, FILES, CODE)).toBe(
    null,
  );
  expect(sharedLines({ stdout, stderr: "", exitCode: 0 }, FILES, CODE)).toEqual(
    [[], []],
  );
});

test("a shared run with reports is accepted only when oxlint exits 1", () => {
  const stdout = sharedReport([
    ["/scratch/b/source.ts", 3],
    ["/scratch/b/source.ts", 1],
  ]);
  expect(sharedLines({ stdout, stderr: "", exitCode: 1 }, FILES, CODE)).toEqual(
    [[], [1, 3]],
  );
  expect(sharedLines({ stdout, stderr: "", exitCode: 0 }, FILES, CODE)).toBe(
    null,
  );
  expect(sharedLines({ stdout, stderr: "", exitCode: 2 }, FILES, CODE)).toBe(
    null,
  );
});

test("parser failures cannot supply clean rule coverage", async () => {
  const result = await Result.tryPromise(
    async () =>
      await lintSingleRule("no-unsafe-inner-html", "const broken = ;", {
        sourcePath: "source.tsx",
      }),
  );
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.message).toContain(
      "oxlint reported a parser or configuration error",
    );
  }
});

test("fix, scratch and override cases never share an oxlint run", () => {
  expect(lintsAlone({})).toBe(false);
  expect(lintsAlone({ cwd: "repository", fix: false })).toBe(false);
  expect(lintsAlone({ fix: true })).toBe(true);
  expect(lintsAlone({ cwd: "scratch" })).toBe(true);
  expect(lintsAlone({ overrides: [] })).toBe(true);
});

test("concurrent fix cases each return their isolated result", async () => {
  const source = 'const view = <div className="ml-2 text-right" />;';
  const isolated = {
    lines: [],
    source: 'const view = <div className="ms-2 text-end" />;',
  };
  const results = await Promise.all(
    Array.from({ length: 3 }, async () =>
      runSingleRule("no-physical-properties", source, {
        sourcePath: "source.tsx",
        fix: true,
      }),
    ),
  );
  expect(results).toEqual([isolated, isolated, isolated]);
});
