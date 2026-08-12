import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

// Repo root, four levels up from this file (packages/property-testing/src).
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * Guard: every environment variable a test suite reads to decide whether to
 * run (a "CI gate") must be turned on by a workflow that also runs that
 * suite, either directly or through a declared dynamic runner.
 *
 * Env-gated suites (`describe.skipIf(process.env["X"] !== "1")`, or an
 * `if (...) describe.skip else describe`) look like coverage but execute
 * nowhere unless a workflow sets the gate variable and invokes the file.
 * When neither happens, the suite is permanently skipped while still
 * counting as a passing test: an upstream-API drift canary or a Postgres
 * integration suite that never runs. This guard fails the moment a gated
 * file has no workflow that both sets its gate and runs it.
 *
 * Coverage is tracked per (gate, file), not per gate name alone: unrelated
 * suites elsewhere in the repo can reuse the same gate name while never being
 * invoked by any job. Matching only the gate name would treat those as covered
 * because a workflow happens to mention the same string for a different
 * file.
 *
 * Gates are discovered by pattern, not a hardcoded list. The comparison must
 * participate in a recognized skip predicate whose inverse makes the suite
 * active when the environment value equals the literal. Ambiguous inverse
 * gates fail this guard instead of treating a disabling value as activation.
 * Always-present config such as `DATABASE_URL` is not matched, because tests
 * read it without a literal comparison.
 *
 * Dynamic runners declare their gate, activation value, and discovery glob in
 * their workspace's `package.json#ciGateTestRunners`. The workflow must invoke
 * the matching package script from that workspace. The runner reads the same
 * declaration, so its runtime discovery and this guard cannot drift into
 * mirrored lists.
 *
 * Extension points:
 * - LOCAL_ONLY_GATES: a gate intentionally exercised only in local runs
 *   (never in CI). Documents the exemption instead of silently weakening
 *   the pattern.
 * - UNWIRED_TEST_FILES: a gated file that is not yet wired into any
 *   workflow by design (e.g. a live third-party API smoke suite that is a
 *   separate follow-up decision from the suite this change wires up).
 */
const LOCAL_ONLY_GATES = new Set<string>();

// Live-API smoke suites not wired into a workflow. Remove an entry once its
// workflow job exists; the test below rejects entries that no longer declare a
// gate, so this policy list cannot silently retain stale paths.
const UNWIRED_TEST_FILES = new Set<string>();

const TEST_FILE_GLOB = "{apps,packages}/**/*.test.{ts,tsx}";
const PACKAGE_JSON_GLOB = "{apps,packages}/*/package.json";
const WORKFLOW_GLOB = ".github/workflows/*.{yml,yaml}";

// process.env.NAME or process.env["NAME"], compared with ===, !==, ==, or !=
// against a string literal.
const GATE_PATTERN =
  /process\.env(?:\s*\.\s*([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])\s*(===|!==|==|!=)\s*["']([^"']*)["']/gu;

// This guard's own source names the gate variables in prose; skip it so it
// does not report itself as a gate declaration.
const SELF_PATH = "packages/property-testing/src/ci-gate-coverage.test.ts";

type GateDeclaration = { gate: string; gateValue: string; file: string };

type GateScanResult = {
  declarations: GateDeclaration[];
  unsupported: string[];
};

const directIfComparisonActivatesSuite = (
  sourceAfterComparison: string,
  comparisonTrueWhenEqual: boolean,
): boolean | undefined => {
  const branches =
    /^\s*\)\s*\{\s*(describe(?:\.skip)?)\b[\s\S]*?\}\s*else\s*\{\s*(describe(?:\.skip)?)\b/u.exec(
      sourceAfterComparison,
    );
  if (!branches) {
    return undefined;
  }
  const comparisonTrueSkips = branches[1] === "describe.skip";
  const comparisonFalseSkips = branches[2] === "describe.skip";
  if (comparisonTrueSkips === comparisonFalseSkips) {
    return undefined;
  }
  const activeWhenComparisonTrue = comparisonFalseSkips;
  return comparisonTrueWhenEqual === activeWhenComparisonTrue;
};

const comparisonLiteralActivatesSuite = (
  source: string,
  match: RegExpMatchArray,
): boolean => {
  const operator = match[3];
  const comparisonTrueWhenEqual = operator === "===" || operator === "==";
  const prefix = source.slice(0, match.index);
  if (/describe\.skipIf\(\s*$/u.test(prefix)) {
    return !comparisonTrueWhenEqual;
  }
  if (/if\s*\(\s*$/u.test(prefix)) {
    const sourceAfterComparison = source.slice(
      (match.index ?? 0) + match[0].length,
    );
    return (
      directIfComparisonActivatesSuite(
        sourceAfterComparison,
        comparisonTrueWhenEqual,
      ) ?? false
    );
  }

  const assignment = /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/u.exec(prefix);
  const identifier = assignment?.[1];
  if (!identifier) {
    return false;
  }

  const skipWhenTrue = new RegExp(
    `describe\\.skipIf\\(\\s*${identifier}\\s*\\)`,
    "u",
  ).test(source);
  const skipWhenFalse =
    new RegExp(`describe\\.skipIf\\(\\s*!\\s*${identifier}\\s*\\)`, "u").test(
      source,
    ) ||
    new RegExp(
      `if\\s*\\([^)]*!\\s*${identifier}\\b[^)]*\\)\\s*\\{\\s*describe\\.skip`,
      "su",
    ).test(source);
  if (skipWhenTrue === skipWhenFalse) {
    return false;
  }
  const activeWhenComparisonTrue = skipWhenFalse;
  return comparisonTrueWhenEqual === activeWhenComparisonTrue;
};

type ScanGatesOptions = {
  file: string;
  source: string;
};

const scanGates = ({ file, source }: ScanGatesOptions): GateScanResult => {
  const declarations: GateDeclaration[] = [];
  const unsupported: string[] = [];
  for (const match of source.matchAll(GATE_PATTERN)) {
    const gate = match[1] || match[2];
    const gateValue = match[4];
    if (!gate || gateValue === undefined || LOCAL_ONLY_GATES.has(gate)) {
      continue;
    }
    if (!comparisonLiteralActivatesSuite(source, match)) {
      unsupported.push(`${gate} (declared in ${file})`);
      continue;
    }
    declarations.push({ gate, gateValue, file });
  }
  return { declarations, unsupported };
};

const collectGates = async (): Promise<GateScanResult> => {
  const glob = new Bun.Glob(TEST_FILE_GLOB);
  const declarations: GateDeclaration[] = [];
  const unsupported: string[] = [];
  const seen = new Set<string>();
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
    if (relativePath.includes("node_modules") || relativePath === SELF_PATH) {
      continue;
    }
    const source = await Bun.file(path.resolve(REPO_ROOT, relativePath)).text();
    const scan = scanGates({ file: relativePath, source });
    unsupported.push(...scan.unsupported);
    for (const declaration of scan.declarations) {
      const key = `${declaration.gate} ${declaration.gateValue} ${relativePath}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      declarations.push(declaration);
    }
  }
  return { declarations, unsupported };
};

type Workflow = { path: string; text: string };

type CiGateTestRunner = {
  gate: string;
  gateValue: string;
  packageRoot: string;
  script: string;
  testFileGlob: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (
  record: Record<string, unknown>,
  key: string,
  sourcePath: string,
): string => {
  const value = record[key];
  if (typeof value !== "string") {
    throw new TypeError(`${sourcePath} must declare a string ${key}`);
  }
  return value;
};

const isStandaloneRunnerPath = (runner: string): boolean =>
  runner === path.posix.normalize(runner) &&
  !path.posix.isAbsolute(runner) &&
  !runner.startsWith("../") &&
  /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[cm]?[jt]sx?$/u.test(runner);

const readCiGateTestRunners = async (): Promise<CiGateTestRunner[]> => {
  const glob = new Bun.Glob(PACKAGE_JSON_GLOB);
  const runners: CiGateTestRunner[] = [];
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
    const packageJson: unknown = JSON.parse(
      await Bun.file(path.resolve(REPO_ROOT, relativePath)).text(),
    );
    if (!isRecord(packageJson)) {
      throw new TypeError(`${relativePath} must contain a JSON object`);
    }
    const runnerDeclarations = packageJson["ciGateTestRunners"];
    if (runnerDeclarations === undefined) {
      continue;
    }
    const scripts = packageJson["scripts"];
    if (!isRecord(runnerDeclarations) || !isRecord(scripts)) {
      throw new TypeError(
        `${relativePath} must declare ciGateTestRunners and scripts as objects`,
      );
    }
    const packageRoot = path.posix.dirname(relativePath);
    for (const [script, declaration] of Object.entries(runnerDeclarations)) {
      if (!isRecord(declaration)) {
        throw new TypeError(
          `${relativePath}#ciGateTestRunners.${script} must be an object`,
        );
      }
      const runner = requireString(declaration, "runner", relativePath);
      if (!isStandaloneRunnerPath(runner)) {
        throw new TypeError(
          `${relativePath}#ciGateTestRunners.${script}.runner must be a standalone relative script path`,
        );
      }
      const runnerPath = path.resolve(REPO_ROOT, packageRoot, runner);
      if (!existsSync(runnerPath) || !statSync(runnerPath).isFile()) {
        throw new TypeError(
          `${relativePath}#ciGateTestRunners.${script}.runner must exist`,
        );
      }
      const scriptCommand = requireString(scripts, script, relativePath);
      if (scriptCommand !== `bun ${runner}`) {
        throw new TypeError(
          `${relativePath}#scripts.${script} must invoke its declared runner`,
        );
      }
      runners.push({
        gate: requireString(declaration, "gate", relativePath),
        gateValue: requireString(declaration, "gateValue", relativePath),
        packageRoot,
        script,
        testFileGlob: requireString(declaration, "testFileGlob", relativePath),
      });
    }
  }
  return runners;
};

const readWorkflows = async (): Promise<Workflow[]> => {
  const glob = new Bun.Glob(WORKFLOW_GLOB);
  const workflows: Workflow[] = [];
  // `dot: true` so the scan descends into the hidden `.github` directory.
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT, dot: true })) {
    workflows.push({
      path: relativePath,
      text: await Bun.file(path.resolve(REPO_ROOT, relativePath)).text(),
    });
  }
  return workflows;
};

type WorkflowStep = {
  allowsFailure: boolean;
  isUnconditional: boolean;
  run: string;
  workingDirectory: string;
};

const parseWorkflow = (workflow: Workflow): Record<string, unknown> => {
  const parsed: unknown = Bun.YAML.parse(workflow.text);
  if (!isRecord(parsed)) {
    throw new TypeError(`${workflow.path} must contain a YAML object`);
  }
  return parsed;
};

const collectWorkflowSteps = (workflow: Workflow): WorkflowStep[] => {
  const parsed = parseWorkflow(workflow);
  const jobs = parsed["jobs"];
  if (!isRecord(jobs)) {
    return [];
  }

  const workflowSteps: WorkflowStep[] = [];
  for (const job of Object.values(jobs)) {
    if (!isRecord(job)) {
      continue;
    }
    const jobContinueOnError = job["continue-on-error"];
    const jobAllowsFailure =
      jobContinueOnError !== undefined && jobContinueOnError !== false;
    const jobCondition = job["if"];
    const jobIsUnconditional =
      jobCondition === undefined || jobCondition === true;
    const steps = job["steps"];
    if (!Array.isArray(steps)) {
      continue;
    }
    for (const step of steps) {
      if (!isRecord(step)) {
        continue;
      }
      const run = step["run"];
      const workingDirectory = step["working-directory"];
      if (typeof run === "string" && typeof workingDirectory === "string") {
        const stepContinueOnError = step["continue-on-error"];
        const stepCondition = step["if"];
        workflowSteps.push({
          allowsFailure:
            jobAllowsFailure ||
            (stepContinueOnError !== undefined &&
              stepContinueOnError !== false),
          isUnconditional:
            jobIsUnconditional &&
            (stepCondition === undefined || stepCondition === true),
          run,
          workingDirectory,
        });
      }
    }
  }
  return workflowSteps;
};

const workflowRunsPackageScript = (
  workflow: Workflow,
  runner: CiGateTestRunner,
): boolean => {
  const invocation = `bun run ${runner.script}`;
  return collectWorkflowSteps(workflow).some(
    ({ allowsFailure, isUnconditional, run, workingDirectory }) =>
      !allowsFailure &&
      isUnconditional &&
      workingDirectory === runner.packageRoot &&
      run.trim() === invocation,
  );
};

type RunnerCoversOptions = {
  declaration: GateDeclaration;
  runner: CiGateTestRunner;
  workflows: Workflow[];
};

const runnerCovers = ({
  declaration,
  runner,
  workflows,
}: RunnerCoversOptions): boolean => {
  if (
    runner.gate !== declaration.gate ||
    runner.gateValue !== declaration.gateValue
  ) {
    return false;
  }
  const relativeFile = path.posix.relative(
    runner.packageRoot,
    declaration.file,
  );
  if (relativeFile.startsWith("../")) {
    return false;
  }
  return (
    new Bun.Glob(runner.testFileGlob).match(relativeFile) &&
    workflows.some((workflow) => workflowRunsPackageScript(workflow, runner))
  );
};

const workflowSetsGate = (
  workflow: Workflow,
  declaration: GateDeclaration,
): boolean => {
  const environmentSetsGate = (environment: unknown): boolean => {
    if (!isRecord(environment)) {
      return false;
    }
    const value = environment[declaration.gate];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return false;
    }
    return String(value) === declaration.gateValue;
  };

  const parsed = parseWorkflow(workflow);
  if (environmentSetsGate(parsed["env"])) {
    return true;
  }
  const jobs = parsed["jobs"];
  if (!isRecord(jobs)) {
    return false;
  }
  for (const job of Object.values(jobs)) {
    if (!isRecord(job)) {
      continue;
    }
    if (environmentSetsGate(job["env"])) {
      return true;
    }
    const steps = job["steps"];
    if (!Array.isArray(steps)) {
      continue;
    }
    for (const step of steps) {
      if (isRecord(step) && environmentSetsGate(step["env"])) {
        return true;
      }
    }
  }
  return false;
};

// Suffixes of a repo-relative path, longest first, dropping at least one
// leading segment each step and stopping before the bare filename. Workflow
// steps run tests from a `working-directory` (e.g. `apps/api`), so the
// command text only ever contains a path relative to that directory, never
// the full repo-relative path. Requiring >= 2 segments avoids treating a
// coincidental filename mention (e.g. in a comment) as evidence the file
// actually runs.
const pathSuffixes = (file: string): string[] => {
  const segments = file.split("/");
  const suffixes: string[] = [];
  for (let dropped = 0; dropped < segments.length - 1; dropped++) {
    suffixes.push(segments.slice(dropped).join("/"));
  }
  return suffixes;
};

// A declaration is wired when some single workflow both sets the gate and
// runs the declaring file. Checking the gate name against the whole
// workflow corpus alone is not enough: see the UNWIRED_TEST_FILES doc above
// for why that produces false coverage.
type IsWiredOptions = {
  declaration: GateDeclaration;
  runners: CiGateTestRunner[];
  workflows: Workflow[];
};

const isWired = ({
  declaration,
  runners,
  workflows,
}: IsWiredOptions): boolean => {
  const suffixes = pathSuffixes(declaration.file);
  const directlyWired = workflows.some(
    (workflow) =>
      workflowSetsGate(workflow, declaration) &&
      suffixes.some((suffix) => workflow.text.includes(suffix)),
  );
  return (
    directlyWired ||
    runners.some((runner) => runnerCovers({ declaration, runner, workflows }))
  );
};

describe("ci-gate coverage convention", () => {
  test("requires standalone runner paths", () => {
    expect(isStandaloneRunnerPath("scripts/run-postgres-tests.ts")).toBe(true);
    expect(
      isStandaloneRunnerPath("scripts/run-postgres-tests.ts || true"),
    ).toBe(false);
    expect(isStandaloneRunnerPath("../run-postgres-tests.ts")).toBe(false);
    expect(isStandaloneRunnerPath("/tmp/run-postgres-tests.ts")).toBe(false);
  });

  test("matches workflow gate values as complete YAML scalars", () => {
    const declaration = {
      file: "apps/api/src/example.test.ts",
      gate: "EXAMPLE_GATE",
      gateValue: "1",
    };
    const workflowWithPrefix = {
      path: ".github/workflows/ci.yml",
      text: `jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - env:
          EXAMPLE_GATE: 10
        run: bun test apps/api/src/example.test.ts`,
    };
    const workflowWithExactValue = {
      path: ".github/workflows/ci.yml",
      text: `jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - env:
          EXAMPLE_GATE: "1"
        run: bun test apps/api/src/example.test.ts`,
    };

    expect(workflowSetsGate(workflowWithPrefix, declaration)).toBe(false);
    expect(workflowSetsGate(workflowWithExactValue, declaration)).toBe(true);
  });

  test("recognizes direct if-gate predicates and their polarity", () => {
    const file = "apps/api/src/example.test.ts";
    const scan = scanGates({
      file,
      source: `if (process.env["ENABLED_GATE"] !== "1") {
  describe.skip("enabled", () => {});
} else {
  describe("enabled", () => {});
}
if (process.env["INVERSE_GATE"] === "1") {
  describe.skip("inverse", () => {});
} else {
  describe("inverse", () => {});
}`,
    });

    expect(scan).toEqual({
      declarations: [{ file, gate: "ENABLED_GATE", gateValue: "1" }],
      unsupported: [`INVERSE_GATE (declared in ${file})`],
    });
  });

  test("rejects compared values that disable their suites", () => {
    const file = "apps/api/src/example.test.ts";
    const scan = scanGates({
      file,
      source: `describe.skipIf(process.env["DIRECT_GATE"] === "1")("direct", () => {});
const SKIP_INDIRECT = process.env["INDIRECT_GATE"] === "1";
describe.skipIf(SKIP_INDIRECT)("indirect", () => {});`,
    });

    expect(scan).toEqual({
      declarations: [],
      unsupported: [
        `DIRECT_GATE (declared in ${file})`,
        `INDIRECT_GATE (declared in ${file})`,
      ],
    });
  });

  test("does not cover a suite with a different activation value", () => {
    const declaration = {
      file: "apps/api/src/db/root.test.ts",
      gate: "STELLA_RUN_POSTGRES_TESTS",
      gateValue: "1",
    };
    const runner = {
      gate: "STELLA_RUN_POSTGRES_TESTS",
      gateValue: "true",
      packageRoot: "apps/api",
      script: "test:postgres",
      testFileGlob: "src/**/*.test.{ts,tsx}",
    };
    const workflows = [
      {
        path: ".github/workflows/ci.yml",
        text: `jobs:
  postgres-suites:
    runs-on: ubuntu-latest
    steps:
      - name: Run gated tests
        working-directory: apps/api
        run: bun run test:postgres`,
      },
    ];

    expect(runnerCovers({ declaration, runner, workflows })).toBe(false);
  });

  test("does not accept a longer package script name", () => {
    const runner = {
      gate: "STELLA_RUN_POSTGRES_TESTS",
      gateValue: "true",
      packageRoot: "apps/api",
      script: "test:postgres",
      testFileGlob: "src/**/*.test.{ts,tsx}",
    };
    const workflow = {
      path: ".github/workflows/ci.yml",
      text: `jobs:
  postgres-suites:
    runs-on: ubuntu-latest
    steps:
      - name: Run gated tests
        working-directory: apps/api
        run: bun run test:postgres-disabled`,
    };

    expect(workflowRunsPackageScript(workflow, runner)).toBe(false);
  });

  test("does not accept a runner that can be skipped or masked", () => {
    const runner = {
      gate: "STELLA_RUN_POSTGRES_TESTS",
      gateValue: "true",
      packageRoot: "apps/api",
      script: "test:postgres",
      testFileGlob: "src/**/*.test.{ts,tsx}",
    };
    const shellMasked = {
      path: ".github/workflows/ci.yml",
      text: `jobs:
  postgres-suites:
    runs-on: ubuntu-latest
    steps:
      - working-directory: apps/api
        run: bun run test:postgres || true`,
    };
    const continueOnError = {
      path: ".github/workflows/ci.yml",
      text: `jobs:
  postgres-suites:
    runs-on: ubuntu-latest
    steps:
      - continue-on-error: true
        working-directory: apps/api
        run: bun run test:postgres`,
    };
    const disabled = {
      path: ".github/workflows/ci.yml",
      text: `jobs:
  postgres-suites:
    runs-on: ubuntu-latest
    steps:
      - if: false
        working-directory: apps/api
        run: bun run test:postgres`,
    };
    const disabledJob = {
      path: ".github/workflows/ci.yml",
      text: `jobs:
  postgres-suites:
    if: false
    runs-on: ubuntu-latest
    steps:
      - working-directory: apps/api
        run: bun run test:postgres`,
    };

    expect(workflowRunsPackageScript(shellMasked, runner)).toBe(false);
    expect(workflowRunsPackageScript(continueOnError, runner)).toBe(false);
    expect(workflowRunsPackageScript(disabled, runner)).toBe(false);
    expect(workflowRunsPackageScript(disabledJob, runner)).toBe(false);
  });

  test("keeps the package directory and invocation in one workflow step", () => {
    const runner = {
      gate: "STELLA_RUN_POSTGRES_TESTS",
      gateValue: "true",
      packageRoot: "apps/api",
      script: "test:postgres",
      testFileGlob: "src/**/*.test.{ts,tsx}",
    };
    const separateSteps = {
      path: ".github/workflows/ci.yml",
      text: `jobs:
  postgres-suites:
    runs-on: ubuntu-latest
    steps:
      - working-directory: apps/api
        run: bun run src/db/migrate.ts
      - run: bun run test:postgres`,
    };
    const sameUnnamedStep = {
      path: ".github/workflows/ci.yml",
      text: `jobs:
  postgres-suites:
    runs-on: ubuntu-latest
    steps:
      - run: bun run test:postgres
        working-directory: apps/api`,
    };

    expect(workflowRunsPackageScript(separateSteps, runner)).toBe(false);
    expect(workflowRunsPackageScript(sameUnnamedStep, runner)).toBe(true);
  });

  test("every env-gated test suite has a workflow that runs it with its gate set", async () => {
    const [gateScan, workflows, runners] = await Promise.all([
      collectGates(),
      readWorkflows(),
      readCiGateTestRunners(),
    ]);
    const { declarations, unsupported } = gateScan;

    expect(unsupported.sort()).toEqual([]);

    // Sanity: the known gates must still be discovered by the pattern.
    // A miss here means the detection rotted, not that coverage is fine.
    const discoveredGates = [
      ...new Set(declarations.map((d) => d.gate)),
    ].sort();
    expect(discoveredGates).toEqual(
      expect.arrayContaining(["SMOKE_TEST", "STELLA_RUN_POSTGRES_TESTS"]),
    );

    const discoveredFiles = new Set(
      declarations.map((declaration) => declaration.file),
    );
    const staleExemptions = [...UNWIRED_TEST_FILES]
      .filter((file) => !discoveredFiles.has(file))
      .sort();
    expect(staleExemptions).toEqual([]);

    const uncovered = declarations
      .filter(
        (declaration) =>
          !UNWIRED_TEST_FILES.has(declaration.file) &&
          !isWired({ declaration, runners, workflows }),
      )
      .map(({ gate, file }) => `${gate} (declared in ${file})`)
      .sort();
    expect(uncovered).toEqual([]);
  });
});
