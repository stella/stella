import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import apiManifest from "../apps/api/package.json" with { type: "json" };
import { parseGatedTestSelection } from "../apps/api/scripts/gated-test-selection";
import { restrictApiTestFiles } from "../apps/api/scripts/test-file-shards";
import { partitionRunnerArguments } from "../apps/api/scripts/test-path-filters";
import webManifest from "../apps/web/package.json" with { type: "json" };
import { planTestRuns } from "../apps/web/scripts/test-run-plan";
import { allApiTests, type selectApiTestImpact } from "./api-test-impact";
import {
  computeChangedFileScope,
  DEFAULT_DETECTORS,
  scopeOutputLines,
} from "./ci-plan-scope";
import {
  annotationData,
  annotationProperty,
  BUDGET_MS,
  executeGate,
  failureAnnotation,
  MAX_CHANGED_TEST_FILES,
  planRepeats,
  renderReport,
  REPEATS,
  type Report,
  reportExitCode,
  runOnce,
  selectTargets,
  type Target,
  trialCommand,
} from "./flake-gate";

// Markdown reads consume temporary CLI output only.
export const CI_MARKDOWN_READER_INPUTS = [] as const;

test("CI repeats changed tests only on pull requests in one existing test shard", async () => {
  const source = await Bun.file(
    new URL("../.github/workflows/ci.yml", import.meta.url),
  ).text();
  expect(source).toContain("github.event_name == 'pull_request'");
  expect(source).toContain("matrix.shard == 'rest-web'");
  expect(source).toContain(
    [
      `cat > "$RUNNER_TEMP/changed-files.json" <<'CHANGED_FILES_JSON'\n`,
      "          $",
      "{{ needs.ci-plan.outputs.changed_files }}\n",
      "          CHANGED_FILES_JSON\n",
      `          CHANGED_FILES_PATH="$RUNNER_TEMP/changed-files.json" bun scripts/flake-gate.ts --blocking`,
    ].join(""),
  );
  expect(source).not.toContain("CHANGED_FILES_JSON: $");
  // Repeated tests read the API runtime their own jobs generate.
  expect(source).toContain(
    [
      "          bun --cwd=packages/cli run codegen:runtime\n",
      "          bun --cwd=apps/api run generate:capability-runtime\n",
      `          cat > "$RUNNER_TEMP/changed-files.json"`,
    ].join(""),
  );
  expect(MAX_CHANGED_TEST_FILES).toBeGreaterThan(0);
  expect(REPEATS).toBe(5);
});

test.each([
  [
    "file.ts: first, second",
    "file.ts: first, second",
    "file.ts%3A first%2C second",
  ],
  [
    "100%\r\n::warning::",
    "100%25%0D%0A::warning::",
    "100%25%0D%0A%3A%3Awarning%3A%3A",
  ],
])(
  "workflow warnings escape data and properties separately: %s",
  (input, data, property) => {
    expect(annotationData(input)).toBe(data);
    expect(annotationProperty(input)).toBe(property);
  },
);

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
const targetFor = (root: string, file = "fixture.test.ts") =>
  ({
    file,
    cwd: root,
    command: [process.execPath, "test", `./${file}`],
    env: {},
    runner: "bun",
  }) satisfies Target;

test("diff selection repeats changed tests only and preserves package runners and service gates", async () => {
  await withFixture((root) => {
    write(root, "apps/api/package.json", JSON.stringify(apiManifest));
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
    const selectedUnit = selected.targets.at(0);
    if (!selectedUnit || selectedUnit.runner !== "api") {
      throw new TypeError("Expected selected API unit runner");
    }
    expect(selectedUnit.command).toEqual([
      process.execPath,
      "scripts/run-tests.ts",
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
    if (!withDb || withDb.runner !== "api") {
      throw new TypeError("Expected selected Postgres runner");
    }
    expect(withDb.command).toEqual([
      process.execPath,
      apiManifest.ciGateTestRunners["test:postgres"].runner,
      "./src/db.test.ts",
    ]);
    expect(withDb.env).toEqual({
      STELLA_RUN_POSTGRES_TESTS: "true",
      CI_POSTGRES_TEST_SELECTION: JSON.stringify({
        mode: "selected",
        files: ["src/db.test.ts"],
      }),
      CI_POSTGRES_TEST_SHARD: "",
    });
  });
});

test("the real API manifest selects unit and Postgres files through their exact owning entries", () => {
  const root = path.resolve(import.meta.dir, "..");
  const unit = "apps/api/scripts/api-test-command.test.ts";
  const postgres = "apps/api/src/db/prod-parity.postgres.test.ts";
  // The regression must reach the compound script and service wrapper from the repository.
  expect(apiManifest.scripts.test).toContain(
    "bun --cwd=../../packages/cli run codegen:runtime &&",
  );
  expect(apiManifest.scripts.test).toContain("&& bun scripts/run-tests.ts");
  expect(apiManifest.scripts["test:postgres"]).toBe(
    `bun ${apiManifest.ciGateTestRunners["test:postgres"].runner}`,
  );
  const options = {
    root,
    changed: [unit, postgres],
    hasDb: true,
    apiImpact: allApiTests,
  };
  const selected = selectTargets(options);
  expect(selected.skipped).toEqual([]);
  expect(selected.targets.map(({ file }) => file).toSorted()).toEqual(
    [unit, postgres].toSorted(),
  );
  for (const target of selected.targets) {
    const relative = target.file.slice("apps/api/".length);
    const isPostgres = target.file === postgres;
    expect(target.runner).toBe("api");
    if (target.runner !== "api") {
      throw new TypeError("Expected API runner");
    }
    expect(target.cwd).toBe(path.join(root, "apps/api"));
    expect(target.command).toEqual([
      process.execPath,
      isPostgres
        ? apiManifest.ciGateTestRunners["test:postgres"].runner
        : "scripts/run-tests.ts",
      `./${relative}`,
    ]);
    const argv = trialCommand(target, 37).slice(2);
    expect(partitionRunnerArguments(argv)).toEqual({
      patterns: [`./${relative}`],
      bunArguments: ["--rerun-each=1", "--randomize", "--seed=37"],
    });
    const discovered = [relative, "src/unchanged.test.ts"];
    if (isPostgres) {
      expect(
        parseGatedTestSelection(
          target.env["CI_POSTGRES_TEST_SELECTION"],
          discovered,
        ),
      ).toEqual({
        mode: "selected",
        files: [relative],
      });
      expect(target.env["CI_POSTGRES_TEST_SHARD"]).toBe("");
      expect(
        target.env[apiManifest.ciGateTestRunners["test:postgres"].gate],
      ).toBe(apiManifest.ciGateTestRunners["test:postgres"].gateValue);
    } else {
      expect(
        restrictApiTestFiles(discovered, target.env["API_TEST_FILES"]),
      ).toEqual([relative]);
      expect(target.env["API_TEST_SHARD"]).toBe("");
    }
  }
  const withoutDb = selectTargets({ ...options, hasDb: false });
  expect(withoutDb.targets.map(({ file }) => file)).toEqual([unit]);
  expect(withoutDb.skipped).toEqual([
    { file: postgres, reason: "not gated (needs DB)" },
  ]);
});

test("the web entry retains file scoping and its DOM isolation with seeded trial flags", async () => {
  await withFixture((root) => {
    expect(webManifest.scripts.test).toContain("&& bun scripts/run-tests.ts");
    write(root, "apps/web/package.json", JSON.stringify(webManifest));
    const file = "apps/web/src/selected.dom.test.tsx";
    write(root, file, "");
    const selected = selectTargets({ root, changed: [file], hasDb: false });
    expect(selected.skipped).toEqual([]);
    const target = selected.targets.at(0);
    if (!target) {
      throw new TypeError("Expected explicit web file target");
    }
    expect(target.runner).toBe("web");
    if (target.runner !== "web") {
      throw new TypeError("Expected web runner");
    }
    expect(target.command).toEqual([
      process.execPath,
      "scripts/run-tests.ts",
      "./src/selected.dom.test.tsx",
    ]);
    const plan = planTestRuns({
      argv: trialCommand(target, 43).slice(2),
      pathKind: () => "file",
      testFilesIn: () => {
        throw new TypeError("A selected file must not expand directories");
      },
    });
    expect(plan).toEqual({
      runs: [
        {
          label: "dom",
          args: [
            "--isolate",
            "./src/selected.dom.test.tsx",
            "--rerun-each=1",
            "--randomize",
            "--seed=43",
          ],
        },
      ],
      missingPaths: [],
    });
  });
});

test.each(["api", "web"] as const)(
  "%s trials require nonzero Bun test execution",
  async (runner) => {
    await withFixture(async (root) => {
      write(
        root,
        "fixture.test.ts",
        'import {test} from "bun:test"; test("runs", () => {});',
      );
      const target = { ...targetFor(root), runner };
      expect(
        await runOnce({ target, seed: 11, timeoutMs: 10_000 }),
      ).toMatchObject({ passed: true, ranTests: true });
      write(root, "empty.ts", 'console.log("0 pass");');
      expect(
        await runOnce({
          target: { ...target, command: [process.execPath, "empty.ts"] },
          seed: 11,
          timeoutMs: 10_000,
        }),
      ).toMatchObject({ passed: false, status: 0, ranTests: false });
    });
  },
);

test("a failed Bun trial exposes its captured failure without changing its verdict", async () => {
  await withFixture(async (root) => {
    write(
      root,
      "fixture.test.ts",
      'import {expect,test} from "bun:test"; test("visible trial reason",()=>expect("actual").toBe("expected"));',
    );
    const diagnostics: string[] = [];
    const outcome = await runOnce({
      target: targetFor(root),
      seed: 11,
      timeoutMs: 10_000,
      onFailureOutput: (output) => {
        diagnostics.push(output);
      },
    });
    expect(outcome).toMatchObject({ passed: false, status: 1, ranTests: true });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("visible trial reason");
    expect(diagnostics[0]).toContain('"expected"');
  });
});

test("the gate reports bounded output only for the first failed trial of each file", async () => {
  let elapsed = 0;
  const diagnostics: string[] = [];
  const report = await executeGate({
    targets: [
      targetFor(".", "first.test.ts"),
      targetFor(".", "second.test.ts"),
    ],
    skipped: [],
    now: () => elapsed,
    reportFailureOutput: (output) => {
      diagnostics.push(output);
    },
    run: async ({ seed, onFailureOutput }) => {
      elapsed += 1;
      if (seed > 1) {
        onFailureOutput?.(`${"x".repeat(32_768)}failure seed ${seed}`);
      }
      return {
        type: "executed",
        passed: seed === 1,
        status: seed === 1 ? 0 : 1,
        ranTests: true,
        failedTests: seed === 1 ? [] : ["fixture"],
      };
    },
  });
  expect(diagnostics).toHaveLength(2);
  for (const [index, output] of diagnostics.entries()) {
    expect(output).toContain(index === 0 ? "first.test.ts" : "second.test.ts");
    expect(output).toContain("seed 2");
    expect(output).toEndWith("failure seed 2\n");
    expect(output.length).toBeLessThan(16_512);
  }
  expect(
    report.results.map(({ runs, failures }) => ({ runs, failures })),
  ).toEqual([
    { runs: REPEATS, failures: REPEATS - 1 },
    { runs: REPEATS, failures: REPEATS - 1 },
  ]);
  expect(reportExitCode(report, true)).toBe(1);
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

test("mixed runtime packages select their Bun-only command", async () => {
  await withFixture(async (root) => {
    write(
      root,
      "packages/mixed/package.json",
      JSON.stringify({
        scripts: {
          test: "bun run test:bun && cargo test",
          "test:bun": "bun test",
        },
      }),
    );
    write(
      root,
      "packages/mixed/unit.test.ts",
      'import {test} from "bun:test"; test("unit", () => {});',
    );
    const target = selectTargets({
      root,
      changed: ["packages/mixed/unit.test.ts"],
      hasDb: false,
    }).targets.at(0);
    if (!target || target.runner !== "bun") {
      throw new TypeError("Expected Bun-only target");
    }
    expect(target.command).toEqual([
      process.execPath,
      "test",
      "./unit.test.ts",
    ]);
    expect(await runOnce({ target, seed: 1, timeoutMs: 10_000 })).toMatchObject(
      { type: "executed", passed: true },
    );
  });
});

test("selected files replace package directory filters and exclude failing siblings", async () => {
  await withFixture(async (root) => {
    write(
      root,
      "packages/filtered/package.json",
      JSON.stringify({ scripts: { "test:bun": "bun test src" } }),
    );
    write(
      root,
      "packages/filtered/src/selected.test.ts",
      'import {expect,test} from "bun:test"; test("changed", () => expect(true).toBe(true));',
    );
    write(
      root,
      "packages/filtered/src/sibling.test.ts",
      'import {expect,test} from "bun:test"; test("unchanged failure", () => expect(true).toBe(false));',
    );
    const target = selectTargets({
      root,
      changed: ["packages/filtered/src/selected.test.ts"],
      hasDb: false,
    }).targets.at(0);
    if (!target) {
      throw new TypeError("Expected selected target");
    }
    expect(await runOnce({ target, seed: 1, timeoutMs: 10_000 })).toMatchObject(
      { type: "executed", passed: true },
    );
  });
});

test("package ignore patterns keep dedicated tests out of normal repeat trials", async () => {
  await withFixture(async (root) => {
    write(
      root,
      "packages/filtered/package.json",
      JSON.stringify({
        scripts: {
          test: "bun test src --path-ignore-patterns '**/*.property.test.ts'",
        },
      }),
    );
    const eligible = "packages/filtered/src/ordinary.test.ts";
    const dedicated = "packages/filtered/src/nested/edition.property.test.ts";
    for (const file of [eligible, dedicated]) {
      write(
        root,
        file,
        'import {test} from "bun:test"; test("case", () => {});',
      );
    }
    const selected = selectTargets({
      root,
      changed: [eligible, dedicated],
      hasDb: false,
    });
    expect(selected.targets.map(({ file }) => file)).toEqual([eligible]);
    expect(selected.skipped).toEqual([
      {
        file: dedicated,
        reason: "not gated (excluded by package test script)",
      },
    ]);
  });
});

test("Cargo target exclusions are reported once as not gated", async () => {
  const target = {
    file: "src/windows/tests.rs",
    cwd: "/fixture",
    env: {},
    crate: "fixture",
    module: "windows::tests",
    runner: "rust",
  } as const satisfies Target;
  let calls = 0;
  const report = await executeGate({
    targets: [target],
    skipped: [],
    run: async () => {
      calls += 1;
      return {
        type: "no-tests",
        reason: "not gated (no tests in module windows::tests)",
      };
    },
  });
  expect(calls).toBe(1);
  expect(report.results).toEqual([]);
  expect(report.skipped).toEqual([
    {
      file: target.file,
      reason: "not gated (no tests in module windows::tests)",
    },
  ]);
  expect(reportExitCode(report, true)).toBe(0);
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
    expect(counts.every((count) => count >= 1 && count <= REPEATS)).toBe(true);
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
      return {
        type: "executed",
        passed: true,
        status: 0,
        ranTests: true,
        failedTests: [],
      };
    },
  });
  expect(timeouts).toEqual([100, 40]);
  expect(report.elapsedMs).toBe(100);
  expect(report.results.map(({ runs }) => runs)).toEqual([1, 1]);
});

test("each test's failing trials are counted for the flaky-test history", async () => {
  const failing = [["math > adds"], [], ["math > adds", "math > divides"]];
  let trial = 0;
  const report = await executeGate({
    targets: [targetFor("/fixture", "a.test.ts")],
    skipped: [],
    run: async () => {
      const failedTests = failing[trial % failing.length] ?? [];
      trial += 1;
      return {
        type: "executed",
        passed: failedTests.length === 0,
        status: failedTests.length === 0 ? 0 : 1,
        ranTests: true,
        failedTests,
      };
    },
  });
  const [result] = report.results;
  expect(result?.runs).toBe(REPEATS);
  const expected: Record<string, number> = {};
  for (let index = 0; index < REPEATS; index += 1) {
    for (const name of failing[index % failing.length] ?? []) {
      expected[name] = (expected[name] ?? 0) + 1;
    }
  }
  expect(result?.failedTests).toEqual(expected);
});

test("a Bun trial reports the names of the tests that failed in it", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "flake-gate-names-"));
  try {
    mkdirSync(path.join(root, "packages/unit"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/unit/package.json"),
      JSON.stringify({ name: "unit", scripts: { test: "bun test" } }),
    );
    writeFileSync(
      path.join(root, "packages/unit/unit.test.ts"),
      'import { describe, expect, test } from "bun:test";\ndescribe("math", () => {\n  test("adds", () => expect(1 + 1).toBe(3));\n  test("subtracts", () => expect(1 - 1).toBe(0));\n});\n',
    );
    const target = selectTargets({
      root,
      changed: ["packages/unit/unit.test.ts"],
      hasDb: false,
    }).targets.at(0);
    if (!target) {
      throw new TypeError("Expected selected fixture");
    }
    expect(await runOnce({ target, seed: 3, timeoutMs: 10_000 })).toMatchObject(
      {
        passed: false,
        failedTests: ["math > adds"],
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports preserve reduced coverage and failures and only blocking mode fails", () => {
  const report: Report = {
    cleanup: {
      type: "best-effort",
      platform: "darwin",
      note: "cleanup: best-effort",
    },
    results: [
      {
        file: "a|b.test.ts",
        runs: 3,
        failures: 1,
        failedIterations: [2],
        failedTests: { adds: 1 },
        durationMs: 10,
        planned: 3,
      },
    ],
    skipped: [{ file: "db.test.ts", reason: "not gated (needs DB)" }],
    errors: [],
    elapsedMs: 100,
  };
  const markdown = renderReport(report);
  expect(markdown).toContain("a\\|b.test.ts");
  expect(markdown).toContain("reduced repeats (cost cap)");
  expect(markdown).toContain("not gated (needs DB)");
  expect(markdown).toContain("cleanup: best-effort");
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

test("repeat runs never overlap across files", async () => {
  let active = 0;
  let peak = 0;
  const report = await executeGate({
    targets: [
      targetFor("/fixture", "a.test.ts"),
      targetFor("/fixture", "b.test.ts"),
    ],
    skipped: [],
    run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(1);
      active -= 1;
      return {
        type: "executed",
        passed: true,
        status: 0,
        ranTests: true,
        failedTests: [],
      };
    },
  });
  expect(report.results.map(({ runs }) => runs)).toEqual([REPEATS, REPEATS]);
  expect(peak).toBe(1);
});

test("five shuffled iterations name the failing iteration", async () => {
  const report = await executeGate({
    targets: [targetFor("/fixture")],
    skipped: [],
    run: async ({ seed }) => ({
      type: "executed",
      passed: seed !== 3,
      status: seed === 3 ? 1 : 0,
      ranTests: true,
      failedTests: seed === 3 ? ["fails on the third shuffle"] : [],
    }),
  });
  const result = report.results.at(0);
  expect(result?.runs).toBe(REPEATS);
  expect(result?.failedIterations).toEqual([3]);
  expect(reportExitCode(report, true)).toBe(1);
});

test("the real runner detects order dependence and rejects zero-test success", async () => {
  await withFixture(async (root) => {
    // The dependent test passes only after every preparer, so most shuffled
    // orders fail it.
    write(
      root,
      "fixture.test.ts",
      `import {expect,test} from "bun:test";
let prepared = 0;
test("prepare a", () => { prepared += 1; });
test("prepare b", () => { prepared += 1; });
test("prepare c", () => { prepared += 1; });
test("requires preparation", () => { expect(prepared).toBe(3); });
`,
    );
    const report = await executeGate({
      targets: [targetFor(root)],
      skipped: [],
    });
    const result = report.results.at(0);
    expect(result?.runs).toBe(REPEATS);
    expect(result?.failures).toBeGreaterThan(0);
    expect(reportExitCode(report, true)).toBe(1);
    write(root, "empty.test.ts", "export {};\n");
    expect(
      await runOnce({
        target: targetFor(root, "empty.test.ts"),
        seed: 1,
        timeoutMs: 10_000,
      }),
    ).toMatchObject({ type: "executed", passed: false });
  });
}, 30_000);

test("the pinned Bun accepts native rerun and shuffle flags", async () => {
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
        String(REPEATS),
        "--randomize",
        "--seed=1",
        "./native.test.ts",
      ],
      { cwd: root, stdout: "ignore", stderr: "ignore" },
    );
    expect(await child.exited).toBe(0);
    expect(await Bun.file(path.join(root, "executions.txt")).text()).toBe(
      "x".repeat(REPEATS),
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
    expect(result).toMatchObject({ type: "executed", passed: false });
    if (result.type !== "executed") {
      throw new TypeError("Expected executed Bun fixture");
    }
    expect(result.status).not.toBe(0);
  });
});

test("owning runner deadlines release sockets held by detached test descendants", async () => {
  await withFixture(async (root) => {
    write(
      root,
      "packages/runner/package.json",
      JSON.stringify({ scripts: { test: "bun test --preload ./runner.ts" } }),
    );
    write(
      root,
      "packages/runner/runner.ts",
      `const child = Bun.spawn([process.execPath, "test", "--timeout=3000", "./hang.test.ts"], { detached: true, stdout: "inherit", stderr: "inherit" });
await child.exited;
`,
    );
    write(
      root,
      "packages/runner/hang.test.ts",
      `import {afterAll,test} from "bun:test";
import {writeFileSync} from "node:fs";
const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture")});
writeFileSync("port.txt", String(server.port));
afterAll(() => server.stop(true));
test("pending", async () => await new Promise(() => {}));
`,
    );
    const target = selectTargets({
      root,
      changed: ["packages/runner/hang.test.ts"],
      hasDb: false,
    }).targets.at(0);
    if (!target) {
      throw new TypeError("Expected owning runner fixture");
    }
    const result = await runOnce({ target, seed: 1, timeoutMs: 500 });
    expect(result).toMatchObject({ type: "executed", status: 124 });
    const port = Number(
      await Bun.file(path.join(root, "packages/runner/port.txt")).text(),
    );
    expect(Number.isSafeInteger(port) && port > 0).toBe(true);
    const rebound = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response("released"),
    });
    await rebound.stop(true);
  });
});

test("the CLI reads a changed-file list larger than one environment variable from its file", async () => {
  const { CHANGED_FILES_PATH: _suppliedChanged, ...inherited } = process.env;
  await withFixture(async (root) => {
    const changed = Array.from(
      { length: 5000 },
      (_, index) =>
        `apps/web/src/features/generated/area-${String(index)}/module.ts`,
    );
    const list = path.join(root, "changed-files.json");
    await Bun.write(list, `${JSON.stringify(changed)}\n`);
    // Linux refuses a single environment string above 128 KiB.
    expect((await Bun.file(list).text()).length).toBeGreaterThan(128 * 1024);
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "flake-gate.ts"),
        "--blocking",
      ],
      {
        cwd: root,
        env: {
          ...inherited,
          // Reading the diff instead of the file would fail on this base.
          BASE_SHA: "refs/heads/missing-flake-gate-fixture-base",
          CHANGED_FILES_PATH: list,
          GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    expect(await child.exited).toBe(0);
    const report: unknown = await Bun.file(
      path.join(root, "flake-gate-report.json"),
    ).json();
    expect(report).toMatchObject({ results: [], errors: [] });
  });
}, 30_000);

test("the CLI emits a JSON error report and report/blocking exit codes on an unreadable diff", async () => {
  // The CI step that repeats this file supplies its own changed-file list,
  // which the CLI prefers over the diff; drop it so the diff is read.
  const { CHANGED_FILES_PATH: _suppliedChanged, ...inherited } = process.env;
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
            ...inherited,
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

test("the CI changed-files output round-trips a path list as one compact JSON line", () => {
  const files = ["apps/web/src/a b.test.ts", "scripts/x.test.ts"];
  const scope = computeChangedFileScope(
    {
      changedFiles: files,
      comparisonBase: "base",
      scopeUnknown: false,
      eventName: "pull_request",
      suiteDepth: "fast",
      heavyOnly: false,
      prTitle: "",
    },
    {
      ...DEFAULT_DETECTORS,
      packageChecks: () => true,
      landingBuild: () => false,
      landingDeploy: () => false,
      desktopBrowser: () => false,
    },
  );
  const lines = scopeOutputLines(scope).filter((line) =>
    line.startsWith("changed_files="),
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain("\n");
  expect(JSON.parse(lines[0]?.replace(/^changed_files=/u, "") ?? "")).toEqual(
    files,
  );
});

test("a failed file annotation cannot inject workflow commands through its name", () => {
  const annotation = failureAnnotation({
    file: "apps/web/a\n::warning::injected.test.ts",
    failedIterations: [2],
  });
  expect(annotation.split("\n")).toHaveLength(1);
  expect(annotation).not.toContain("\n::warning::");
});

test("a failing gate names each failing test with its first assertion line", async () => {
  let trial = 0;
  const report = await executeGate({
    targets: [
      targetFor("/fixture", "a.test.ts"),
      targetFor("/fixture", "b.test.ts"),
    ],
    skipped: [],
    run: async ({ target }) => {
      trial += 1;
      if (target.file.endsWith("b.test.ts")) {
        return {
          type: "executed",
          passed: false,
          status: 134,
          ranTests: false,
          failedTests: [],
          failureDetails: [],
        };
      }
      return {
        type: "executed",
        passed: false,
        status: 1,
        ranTests: true,
        failedTests: ["math > adds"],
        failureDetails: [
          {
            name: "math > adds",
            detail:
              trial === 1 ? "Expected: 2 Received: 3" : "later trial line",
          },
        ],
      };
    },
  });
  const markdown = renderReport(report);
  expect(markdown).toContain("math > adds: Expected: 2 Received: 3");
  expect(markdown).not.toContain("later trial line");
  expect(markdown).toContain(
    "a trial failed with exit status 134 and named no test",
  );
});

test("a failing trial that names tests without details still names them", async () => {
  const report = await executeGate({
    targets: [targetFor("/fixture", "a.test.ts")],
    skipped: [],
    run: async () => ({
      type: "executed",
      passed: false,
      status: 1,
      ranTests: true,
      failedTests: ["math > adds"],
    }),
  });
  const markdown = renderReport(report);
  expect(markdown).toContain("math > adds");
  expect(markdown).not.toContain("named no test");
});
