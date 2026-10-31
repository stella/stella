import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  filesToInspect,
  inspectSourceWrites,
  runSourceWriteCensus,
  writers,
} from "./test-source-write-census";
import {
  sourceWriteExceptionIssues,
  validateSourceWriteExceptions,
} from "./test-source-write-exceptions";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");

// CI measured 6.83s on the failing runner and 3.86s on a passing runner.
// Round twice the slower measurement up to 15s; the outer test gets twice
// that budget so only the child deadline diagnoses a slow census.
const CENSUS_BUDGET_MS = 15_000;

test(
  "tests keep generated files outside application and package source trees",
  () => {
    expect(runSourceWriteCensus({ budgetMs: CENSUS_BUDGET_MS })).toEqual([]);
  },
  CENSUS_BUDGET_MS * 2,
);

test("ledger failures report termination even when Git emits no stderr", () => {
  for (const command of ["merge-base", "ls-tree", "show"]) {
    for (const termination of [
      { status: 1, signal: null, stderr: "" },
      { status: null, signal: "SIGKILL", stderr: "" },
      { status: 128, signal: null, stderr: "fatal: unavailable revision" },
      { status: 0, signal: "SIGTERM", stderr: "" },
    ] as const) {
      const issues = sourceWriteExceptionIssues({
        root: repositoryRoot,
        observed: [],
        git: (args) =>
          args.at(0) === command
            ? { ...termination, stdout: "" }
            : { status: 0, signal: null, stdout: "fixture", stderr: "" },
      });
      expect(issues).toHaveLength(1);
      expect(issues.at(0)).toContain(
        `exit status ${String(termination.status)}, signal ${String(termination.signal)}`,
      );
      expect(issues.at(0)).toContain(
        termination.stderr || "git produced no diagnostic",
      );
    }
  }
});

test("ledger failures preserve a Git spawn error", () => {
  const issues = sourceWriteExceptionIssues({
    root: repositoryRoot,
    observed: [],
    git: () => ({
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      error: new Error("spawnSync git ETIMEDOUT"),
    }),
  });
  expect(issues).toEqual([
    "Source-write ledger merge base unavailable: exit status null, signal SIGKILL; spawnSync git ETIMEDOUT",
  ]);
});

test("ledger loading preserves the first rollout and shrink-only comparison", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-source-write-ledger-"));
  const exception = {
    source: "packages/example/src/example.test.ts",
    operation: "writeFileSync",
    destination: "packages/example/src/baseline.json",
    reason: "Explicit regeneration of a committed baseline.",
  };
  const current = JSON.stringify([exception]);
  const observed = [
    `${exception.source}:12: ${exception.operation} writes into src (${exception.destination})`,
  ];
  try {
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(
      path.join(root, "scripts/test-source-write-exceptions.json"),
      current,
    );
    for (const baseline of [null, current, "[]"]) {
      const issues = sourceWriteExceptionIssues({
        root,
        observed,
        git: (args) => {
          let stdout = "fixture-revision";
          if (args.at(0) === "ls-tree") {
            stdout = baseline === null ? "" : "ledger";
          }
          if (args.at(0) === "show") {
            stdout = baseline ?? "";
          }
          return { status: 0, signal: null, stderr: "", stdout };
        },
      });
      expect(issues).toEqual(
        baseline === "[]"
          ? [
              `Source-write exceptions may only shrink: ${exception.source}: ${exception.operation} writes into src (${exception.destination})`,
            ]
          : [],
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the census inspects test helper directories and fixture modules", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-source-write-census-"));
  const helperFiles = [
    "apps/example/src/tests/helpers/source-mutant.ts",
    "apps/example/src/nested/__tests__/source-mutant.ts",
    "packages/example/src/test-helpers/source-mutant.ts",
    "packages/example/src/nested/test-fixtures/source-mutant.ts",
    "packages/example/src/source.test-helpers.ts",
    "apps/example/src/source.test-fixtures.ts",
    "packages/example/src/source.spec.mts",
  ];
  const excludedFiles = [
    "apps/example/src/helpers/production.ts",
    "packages/example/src/production.ts",
    "apps/example/scripts/outside.test.ts",
  ];
  const source = 'writeFileSync(path.join(import.meta.dir, "mutant.ts"), "");';
  try {
    for (const file of [...helperFiles, ...excludedFiles]) {
      const absoluteFile = path.join(root, file);
      mkdirSync(path.dirname(absoluteFile), { recursive: true });
      writeFileSync(absoluteFile, source);
    }
    const selected = filesToInspect(root);
    expect(selected.toSorted()).toEqual(helperFiles.toSorted());
    const violations = selected.flatMap((file) =>
      inspectSourceWrites(readFileSync(path.join(root, file), "utf-8"), file),
    );
    expect(violations).toHaveLength(helperFiles.length);
    for (const file of helperFiles) {
      expect(
        violations.some((violation) => violation.startsWith(`${file}:`)),
        file,
      ).toBe(true);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("source-write exceptions exactly match observed writes and may only shrink", () => {
  const exception = {
    source: "apps/example/src/example.test.ts",
    operation: "writeFileSync",
    destination: "apps/example/src/baseline.json",
    reason: "Explicit regeneration of a committed baseline.",
  };
  const violation = `${exception.source}:12: ${exception.operation} writes into src (${exception.destination})`;
  const current = JSON.stringify([exception]);
  expect(
    validateSourceWriteExceptions({
      observed: [violation],
      current,
      baseline: current,
    }),
  ).toEqual([]);
  expect(
    validateSourceWriteExceptions({
      observed: [],
      current: "[]",
      baseline: current,
    }),
  ).toEqual([]);
  expect(
    validateSourceWriteExceptions({
      observed: [violation],
      current,
      baseline: "[]",
    }),
  ).toEqual([
    expect.stringContaining("Source-write exceptions may only shrink:"),
  ]);
  expect(
    validateSourceWriteExceptions({ observed: [], current, baseline: current }),
  ).toEqual([
    expect.stringContaining(
      "Source-write exceptions must equal observed debt:",
    ),
  ]);
  expect(
    validateSourceWriteExceptions({
      observed: [violation, violation],
      current,
      baseline: current,
    }),
  ).toEqual([
    expect.stringContaining(
      "Source-write exceptions must equal observed debt:",
    ),
  ]);
  expect(
    validateSourceWriteExceptions({
      observed: [violation],
      current: JSON.stringify([{ ...exception, reason: "" }]),
      baseline: current,
    }),
  ).toContain(
    "Source-write exceptions require source, operation, destination, and a reason",
  );
});

test("only Bun.write is treated as the filesystem write API", () => {
  const destination = '"packages/scripts/src/file.ts"';
  expect(
    inspectSourceWrites(
      `const { write } = fixture(); write(${destination}, "");`,
      "packages/scripts/src/example.test.ts",
    ),
  ).toEqual([]);
  expect(
    inspectSourceWrites(
      `let save; ({ writeFileSync: save } = fixture()); save(${destination}, "");`,
      "packages/scripts/src/example.test.ts",
    ),
  ).toEqual([]);
  expect(
    inspectSourceWrites(
      `fixture.write(${destination}, "");`,
      "packages/scripts/src/example.test.ts",
    ),
  ).toEqual([]);
  expect(
    inspectSourceWrites(
      `Bun.write(${destination}, "");`,
      "packages/scripts/src/example.test.ts",
    ),
  ).toHaveLength(1);
});

test("the census rejects every writer through direct and derived source destinations", () => {
  const destinations = [
    'import.meta.dir + "/mutation.ts"',
    'path.join(__dirname, "mutation.ts")',
    'path?.join(import.meta.dir, "mutation.ts")',
    'import.meta?.dir + "/mutation.ts"',
    'path.resolve(import.meta.dir, "nested", name)',
    'path.join("apps/api/src", name)',
    '"src/mutation.ts"',
    'new URL("./mutation.ts", import.meta.url)',
    "path.join(path.dirname(fileURLToPath(import.meta.url)), name)",
  ];
  for (const [writer, argumentIndexes] of writers) {
    for (const destination of destinations) {
      const arguments_ = ['"fixture"', '"fixture"'];
      for (const index of argumentIndexes) {
        arguments_[index] = "target";
      }
      const fixture = `const root = ${destination}; const target = root; ${writer === "write" ? "Bun.write" : writer}(${arguments_.join(", ")});`;
      expect(
        inspectSourceWrites(fixture, "apps/api/src/tests/example.test.ts"),
        fixture,
      ).toHaveLength(argumentIndexes.length);
      const alias = writer === "write" ? "Bun?.write" : `fs?.${writer}`;
      const aliasedFixture = `const target = ${destination}; const save = ${alias}; save(${arguments_.join(", ")});`;
      expect(
        inspectSourceWrites(
          aliasedFixture,
          "apps/api/src/tests/example.test.ts",
        ),
        aliasedFixture,
      ).toHaveLength(argumentIndexes.length);
    }
  }
  expect(
    inspectSourceWrites(
      'import { writeFileSync as save } from "node:fs"; save(path.join(import.meta.dir, "mutant.ts"), "");',
      "packages/scripts/src/example.test.ts",
    ),
  ).toHaveLength(1);
  expect(
    inspectSourceWrites(
      'const dir = mkdtempSync(path.join(import.meta.dir, ".mutants-")); writeFileSync(path.join(dir, "mutant.ts"), "");',
      "packages/scripts/src/example.test.ts",
    ),
  ).toHaveLength(2);
  expect(
    inspectSourceWrites(
      'let directory; directory = import.meta.dir; writeFileSync(path.join(directory, "mutant.ts"), "");',
      "apps/api/src/example.test.ts",
    ),
  ).toHaveLength(1);
  expect(
    inspectSourceWrites(
      'const save = Bun.write; save(path.join(import.meta.dirname, "mutant.ts"), "");',
      "apps/api/src/example.test.ts",
    ),
  ).toHaveLength(1);
  expect(
    inspectSourceWrites(
      'const identity = <T>(value: T) => value; writeFileSync(path.join(import.meta.dir, "mutant.ts"), "");',
      "apps/api/src/example.test.ts",
    ),
  ).toHaveLength(1);
});

test("the census accepts source-shaped fixtures in isolated roots and paths escaping src", () => {
  for (const destination of [
    'path.join(tmpdir(), "fixture/src/mutant.ts")',
    'path.join(import.meta.dir, "../.test-mutants/mutant.ts")',
    'path.resolve(import.meta.dir, "../../../.test-mutants/mutant.ts")',
    'path.join(path.resolve(import.meta.dir, "../../.."), ".test-mutants/mutant.ts")',
  ]) {
    const fixture = `const directory = mkdtempSync(${destination}); writeFileSync(path.join(directory, "src/mutant.ts"), "");`;
    expect(
      inspectSourceWrites(fixture, "apps/api/src/example.test.ts"),
      fixture,
    ).toEqual([]);
  }
  const shadowed =
    'const directory = import.meta.dir; test("isolated", () => { const directory = tmpdir(); writeFileSync(path.join(directory, "src/file.ts"), ""); });';
  expect(inspectSourceWrites(shadowed, "apps/api/src/example.test.ts")).toEqual(
    [],
  );
});
