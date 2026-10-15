import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { selectApiTestImpact } from "./api-test-impact";
import {
  BUDGET_MS,
  executeGate,
  planRepeats,
  renderReport,
  reportExitCode,
  runOnce,
  selectTargets,
  type Report,
  type Target,
} from "./flake-gate";

const withFixture = async (run: (root: string) => void | Promise<void>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "flake-gate-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: {} }),
    );
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const write = (root: string, file: string, source: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
};
const targetFor = (root: string, file = "fixture.test.ts"): Target => ({
  file,
  cwd: root,
  command: [process.execPath, "test", `./${file}`],
  env: {},
  runner: "bun",
});

test("diff selection repeats changed tests only and preserves package runners and service gates", async () => {
  await withFixture((root) => {
    write(
      root,
      "apps/api/package.json",
      JSON.stringify({
        scripts: {
          test: "bun scripts/run-tests.ts",
          "test:postgres": "bun scripts/run-postgres-tests.ts",
        },
      }),
    );
    write(
      root,
      "apps/api/src/unit.test.ts",
      'import {test} from "bun:test"; test("unit",()=>{});',
    );
    write(
      root,
      "apps/api/src/db.test.ts",
      "if (process.env.STELLA_RUN_POSTGRES_TESTS) {}",
    );
    write(root, "apps/api/src/unchanged.test.ts", "");
    write(root, "scripts/direct.spec.ts", "");
    write(
      root,
      "apps/web/e2e/page.spec.ts",
      'import {test} from "@playwright/test";',
    );
    let observed: readonly string[] = [];
    const options = {
      root,
      changed: [
        "apps/api/src/unit.test.ts",
        "apps/api/src/db.test.ts",
        "scripts/direct.spec.ts",
        "apps/web/e2e/page.spec.ts",
        "deleted.test.ts",
      ],
      hasDb: false,
      apiImpact: ({ changed }: Parameters<typeof selectApiTestImpact>[0]) => {
        observed = changed;
        return {
          mode: "selected" as const,
          files: [
            "src/unit.test.ts",
            "src/db.test.ts",
            "src/unchanged.test.ts",
          ],
          shards: 1,
        };
      },
    };
    const selected = selectTargets(options);
    expect(observed).toEqual(options.changed);
    expect(selected.targets.map(({ file }) => file)).toEqual([
      "apps/api/src/unit.test.ts",
      "scripts/direct.spec.ts",
    ]);
    expect(selected.targets.at(0)?.command).toEqual([
      process.execPath,
      "run",
      "test",
      "--",
      "./src/unit.test.ts",
    ]);
    expect(selected.skipped).toEqual(
      expect.arrayContaining([
        { file: "apps/api/src/db.test.ts", reason: "not gated (needs DB)" },
        {
          file: "apps/web/e2e/page.spec.ts",
          reason: "Playwright: not gated in v1",
        },
        { file: "deleted.test.ts", reason: "deleted" },
      ]),
    );
    const withDb = selectTargets({ ...options, hasDb: true }).targets.find(
      ({ file }) => file.endsWith("db.test.ts"),
    );
    expect(withDb?.command).toContain("test:postgres");
    expect(withDb?.env).toEqual({ STELLA_RUN_POSTGRES_TESTS: "true" });
  });
});

test("fixture strings and comments do not classify a Bun test as Playwright", async () => {
  await withFixture((root) => {
    write(
      root,
      "fixture.test.ts",
      `import {test} from "bun:test";
const example = 'import {test} from "@playwright/test";';
// import {test} from "playwright/test";
test("fixture text", () => {});
`,
    );
    const selected = selectTargets({
      root,
      changed: ["fixture.test.ts"],
      hasDb: false,
    });
    expect(selected.targets.map(({ file }) => file)).toEqual([
      "fixture.test.ts",
    ]);
    expect(selected.skipped).toEqual([]);
  });
});

test("allocation never exceeds remaining cost and reduces the slowest files first", () => {
  const measured = [1, 17, 1000, 70_000].map((durationMs) => ({
    file: String(durationMs),
    durationMs,
  }));
  for (const budget of [0, 1, 20, 20_000, BUDGET_MS]) {
    const plan = planRepeats(measured, budget);
    const cost = measured.reduce(
      (sum, { file, durationMs }) =>
        sum + ((plan.get(file) ?? 1) - 1) * durationMs,
      0,
    );
    expect(cost).toBeLessThanOrEqual(budget);
    const counts = measured.map(({ file }) => plan.get(file) ?? 0);
    expect(counts.every((count) => count >= 1 && count <= 20)).toBe(true);
    expect(counts).toEqual(counts.toSorted((a, b) => b - a));
  }
  expect(() => planRepeats([{ file: "invalid", durationMs: 0 }], 1)).toThrow(
    "positive finite duration",
  );
});

test("selected package commands retain their configured preload and shuffled runner flags", async () => {
  await withFixture(async (root) => {
    write(
      root,
      "packages/unit/package.json",
      JSON.stringify({ scripts: { test: "bun test --preload ./preload.ts" } }),
    );
    write(
      root,
      "packages/unit/preload.ts",
      'process.env["FLAKE_GATE_FIXTURE_PRELOADED"] = "yes";',
    );
    write(
      root,
      "packages/unit/unit.test.ts",
      'import {expect,test} from "bun:test"; test("preloaded", () => expect(process.env["FLAKE_GATE_FIXTURE_PRELOADED"]).toBe("yes"));',
    );
    const target = selectTargets({
      root,
      changed: ["packages/unit/unit.test.ts"],
      hasDb: false,
    }).targets.at(0);
    if (!target) {
      throw new TypeError("Expected selected fixture");
    }
    expect(await runOnce({ target, seed: 7, timeoutMs: 10_000 })).toMatchObject(
      {
        passed: true,
        ranTests: true,
        status: 0,
      },
    );
  });
});

test("actual elapsed budget includes probes and stops repeat execution", async () => {
  let elapsed = 0;
  const timeouts: number[] = [];
  const report = await executeGate({
    targets: [
      targetFor("/fixture", "a.test.ts"),
      targetFor("/fixture", "b.test.ts"),
    ],
    skipped: [],
    budgetMs: 100,
    now: () => elapsed,
    run: async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      elapsed += Math.min(60, timeoutMs);
      return { passed: true, status: 0, ranTests: true };
    },
  });
  expect(timeouts).toEqual([100, 40]);
  expect(report.elapsedMs).toBe(100);
  expect(report.results.map(({ runs }) => runs)).toEqual([1, 1]);
});

test("reports preserve reduced coverage and failures and only blocking mode fails", () => {
  const report: Report = {
    results: [
      { file: "a|b.test.ts", runs: 3, failures: 1, durationMs: 10, planned: 3 },
    ],
    skipped: [{ file: "db.test.ts", reason: "not gated (needs DB)" }],
    errors: [],
    elapsedMs: 100,
  };
  const markdown = renderReport(report);
  expect(markdown).toContain("a\\|b.test.ts");
  expect(markdown).toContain("reduced repeats (cost cap)");
  expect(markdown).toContain("not gated (needs DB)");
  expect(reportExitCode(report, false)).toBe(0);
  expect(reportExitCode(report, true)).toBe(1);
  expect(reportExitCode({ ...report, results: [] }, true)).toBe(0);
  expect(
    reportExitCode(
      { ...report, results: [], errors: ["runner unavailable"] },
      true,
    ),
  ).toBe(1);
});

test("a real 20-run shuffled fixture detects order dependence and rejects zero-test success", async () => {
  await withFixture(async (root) => {
    write(
      root,
      "fixture.test.ts",
      `import {expect,test} from "bun:test";
let prepared = false;
test("prepare", () => { prepared = true; });
test("requires preparation", () => { expect(prepared).toBe(true); });
`,
    );
    const report = await executeGate({
      targets: [targetFor(root)],
      skipped: [],
    });
    const result = report.results.at(0);
    expect(result?.runs).toBe(20);
    expect(result?.failures).toBeGreaterThan(0);
    expect(result?.failures).toBeLessThan(20);
    expect(reportExitCode(report, false)).toBe(0);
    expect(reportExitCode(report, true)).toBe(1);
    write(root, "empty.test.ts", "export {};\n");
    expect(
      (
        await runOnce({
          target: targetFor(root, "empty.test.ts"),
          seed: 1,
          timeoutMs: 10_000,
        })
      ).passed,
    ).toBe(false);
  });
}, 30_000);

test("the pinned Bun accepts native rerun and shuffle flags with twenty executions", async () => {
  await withFixture(async (root) => {
    write(
      root,
      "native.test.ts",
      `import {test} from "bun:test";
import {appendFileSync} from "node:fs";
test("native flag probe", () => appendFileSync("executions.txt", "x"));
`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--rerun-each",
        "20",
        "--randomize",
        "--seed=1",
        "./native.test.ts",
      ],
      { cwd: root, stdout: "ignore", stderr: "ignore" },
    );
    expect(await child.exited).toBe(0);
    expect(await Bun.file(path.join(root, "executions.txt")).text()).toBe(
      "x".repeat(20),
    );
  });
});

test("an exhausted subprocess deadline terminates a hanging test", async () => {
  await withFixture(async (root) => {
    write(
      root,
      "hang.test.ts",
      'import {test} from "bun:test"; test("pending", async () => await new Promise(() => {}));',
    );
    const result = await runOnce({
      target: targetFor(root, "hang.test.ts"),
      seed: 1,
      timeoutMs: 50,
    });
    expect(result.passed).toBe(false);
    expect(result.status).not.toBe(0);
  });
});

test("the CLI emits a JSON error report and report/blocking exit codes on an unreadable diff", async () => {
  await withFixture(async (root) => {
    for (const blocking of [false, true]) {
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "flake-gate.ts"),
          ...(blocking ? ["--blocking"] : []),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            BASE_SHA: "refs/heads/missing-flake-gate-fixture-base",
            GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      expect(await child.exited).toBe(blocking ? 1 : 0);
      const report: unknown = await Bun.file(
        path.join(root, "flake-gate-report.json"),
      ).json();
      expect(report).toMatchObject({
        results: [],
        errors: [expect.stringContaining("Cannot read PR diff")],
      });
      expect(await Bun.file(path.join(root, "summary.md")).text()).toContain(
        "Runner error:",
      );
    }
  });
}, 30_000);
