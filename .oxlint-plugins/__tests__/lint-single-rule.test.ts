import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  claimedBatches,
  holdSharedRunUntilPendingForTest,
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
  holdSharedRunUntilPendingForTest(code, 3);
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

test("concurrent cases keep their own lines across any run grouping", async () => {
  const code = "no-raw-browser-storage(no-raw-browser-storage)";
  const before = sharedRuns.filter((run) => run.code === code).length;
  const storage = "localStorage.getItem('key');";
  const results = await Promise.all(
    [
      'const clean = "storage";',
      [storage, "const other = 1;", storage].join("\n"),
      ["const first = 1;", storage].join("\n"),
    ].map(
      async (source) => await lintSingleRule("no-raw-browser-storage", source),
    ),
  );
  expect(results).toEqual([[], [1, 3], [2]]);
  const batches = claimedBatches
    .filter((batch) => batch.code === code)
    .slice(before);
  expect(batches.reduce((cases, batch) => cases + batch.cases, 0)).toBe(3);
});

test("a rejected shared run falls back to lone runs and is not counted as shared", async () => {
  const code = "no-raw-date-parsing(no-raw-date-parsing)";
  const sharedBefore = sharedRuns.filter((run) => run.code === code).length;
  const claimedBefore = claimedBatches.filter(
    (batch) => batch.code === code,
  ).length;
  holdSharedRunUntilPendingForTest(code, 3);
  const dateOnly = 'const parsed = new Date("2024-01-01");';
  // The unparsable case adds a diagnostic that is not this rule's, so the
  // shared report is rejected and every case reruns alone.
  const results = await Promise.all(
    [
      dateOnly,
      "const broken = ;",
      ["const first = 1;", dateOnly].join("\n"),
    ].map(
      async (source) =>
        await Result.tryPromise(async () =>
          lintSingleRule("no-raw-date-parsing", source),
        ),
    ),
  );
  expect(results[0]?.isOk() && results[0].value).toEqual([1]);
  expect(results[2]?.isOk() && results[2].value).toEqual([2]);
  expect(
    claimedBatches.filter((batch) => batch.code === code).slice(claimedBefore),
  ).toEqual([{ code, cases: 3 }]);
  expect(
    sharedRuns.filter((run) => run.code === code).slice(sharedBefore),
  ).toEqual([]);
});
