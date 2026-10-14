import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  lintSingleRule,
  lintsAlone,
  runSingleRule,
  sharedLines,
  sharedRuns,
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

test("concurrent cases of one configuration share a run and keep their own lines", async () => {
  // Only this test in the file lints no-raw-sha256, so its shared runs are
  // exactly the ones recorded while it awaits.
  const code = "no-raw-sha256(no-raw-sha256)";
  const before = sharedRuns.filter((run) => run.code === code).length;
  const hash = 'new Bun.CryptoHasher("sha256");';
  const results = await Promise.all(
    [
      'const clean = "sha256";',
      [hash, "const other = 1;", hash].join("\n"),
      ["const first = 1;", hash].join("\n"),
    ].map(async (source) => await lintSingleRule("no-raw-sha256", source)),
  );
  expect(results).toEqual([[], [1, 3], [2]]);
  expect(sharedRuns.filter((run) => run.code === code).slice(before)).toEqual([
    { code, cases: 3 },
  ]);
});
