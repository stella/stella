import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PRUNABLE_BASELINE_WRITERS } from "./autofix-baseline-prune";
import {
  AUTOFIX_DRIFT_CHECKS,
  fixableCodeCheckTasks,
  poolDriftFailed,
} from "./autofix-drift-checks";
import { CHECK_POOL_JOBS, readCheckPool } from "./ci-check-pool-registry";
import {
  planCheck,
  recordFixableFailure,
  scopedCommands,
} from "./code-check-affected";
import { GENERATORS } from "./generated-files";
import {
  type Context,
  evaluate as evaluateWorkflowExpression,
} from "./github-expression";
import { PR_GENERATORS } from "./pr-regeneration";
import { workflowJobSteps } from "./workflow-steps";

const root = path.resolve(import.meta.dirname, "..");
const readWorkflow = (file: string): unknown =>
  Bun.YAML.parse(readFileSync(path.join(root, file), "utf-8"));
const ci = readWorkflow(".github/workflows/ci.yml");
const autofix = readWorkflow(".github/workflows/autofix.yml");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const packageJson: unknown = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf-8"),
);
const packageScripts = Object.entries(
  isRecord(packageJson) && isRecord(packageJson["scripts"])
    ? packageJson["scripts"]
    : {},
).flatMap(([alias, command]) =>
  typeof command === "string" ? [[alias, command] as const] : [],
);

const jobsOf = (workflow: unknown): Record<string, Record<string, unknown>> => {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    throw new TypeError("workflow must declare jobs");
  }
  const jobs: Record<string, Record<string, unknown>> = {};
  for (const [id, job] of Object.entries(workflow["jobs"])) {
    if (isRecord(job)) {
      jobs[id] = job;
    }
  }
  return jobs;
};
const ciJobs = jobsOf(ci);
const autofixJobs = jobsOf(autofix);

const text = (value: unknown) => (typeof value === "string" ? value : "");
const listed = new Set(
  AUTOFIX_DRIFT_CHECKS.map(({ job, name }) => `${job}/${name}`),
);

/** Every direct and pooled CI check, keyed `job/name`. */
const ciSteps = [
  ...Object.keys(ciJobs).flatMap((job) =>
    "steps" in (ciJobs[job] ?? {})
      ? workflowJobSteps(ci, job).map((step) => ({
          job,
          name: text(step["name"]),
          run: text(step["run"]),
          step,
        }))
      : [],
  ),
  ...CHECK_POOL_JOBS.flatMap((job) =>
    readCheckPool(job).map((check) => ({
      job,
      name: check.name,
      run: check.run,
      step: check.step,
    })),
  ),
];
const stepsRunning = (matches: (line: string) => boolean) =>
  ciSteps
    .filter(
      ({ job, run }) =>
        job !== "ci-quick-checks" &&
        run.split("\n").some((line) => matches(line.trim())),
    )
    .map(({ job, name }) => `${job}/${name}`);

const expectListed = (required: readonly string[], reason: string) => {
  expect(required.length, reason).toBeGreaterThan(0);
  for (const step of required) {
    expect(listed.has(step), `${reason}: ${step}`).toBe(true);
  }
};

describe("CI drift checks that request autofix", () => {
  test("cover formatting, lint and every autofix-owned generator", () => {
    expectListed(
      stepsRunning(
        (line) =>
          line === "bun fmt --check" ||
          (line.includes("turbo run format") && line.includes("--check")),
      ),
      "format check",
    );
    expectListed(
      stepsRunning((line) => /^bun run code-check(?::affected)? /u.test(line)),
      "lint (code-check)",
    );
    expectListed(
      stepsRunning(
        (line) => line === "bun scripts/check-tauri-package-alignment.ts",
      ),
      "Tauri alignment",
    );
    for (const generator of GENERATORS.filter((entry) => entry.autofix)) {
      if (generator.checkedBy) {
        expectListed(
          ciSteps
            .filter(({ name }) => name === generator.checkedBy)
            .map(({ job, name }) => `${job}/${name}`),
          generator.id,
        );
      }
      if (generator.check) {
        // The manifest guard runs every check command; a step that runs one
        // directly (a delegated check) must request autofix too.
        const command = generator.check.join(" ");
        expectListed(
          [
            ...stepsRunning(
              (line) =>
                line === "bun scripts/generated-files-guard.ts --guard-b",
            ),
            ...stepsRunning((line) => line === command),
          ],
          generator.id,
        );
      }
    }
  });

  test("cover every shrink-only baseline autofix prunes", () => {
    for (const { write } of PRUNABLE_BASELINE_WRITERS) {
      const script = write[1];
      const aliases = packageScripts
        .filter(([, command]) => command.split(" ").includes(script))
        .map(([alias]) => `bun run ${alias}`);
      const runsScript = (line: string) =>
        line.split(" ").includes(script) ||
        aliases.some((alias) => line === alias || line.startsWith(`${alias} `));
      expectListed(
        stepsRunning((line) => runsScript(line) && !line.includes("--write")),
        script,
      );
    }
  });

  test("each entry is a step of its job and feeds the job's fixable output", () => {
    for (const { job, name, signal } of AUTOFIX_DRIFT_CHECKS) {
      const step = ciSteps.find(
        (candidate) => candidate.job === job && candidate.name === name,
      );
      expect(step, `${job}/${name}`).toBeDefined();
      const outputs = ciJobs[job]?.["outputs"];
      const fixable = isRecord(outputs) ? text(outputs["fixable"]) : "";
      if (signal === "pool") {
        const pool = CHECK_POOL_JOBS.find((candidate) => candidate === job);
        expect(pool, `${job} runs a check pool`).toBeDefined();
        expect(
          pool === undefined
            ? []
            : readCheckPool(pool).map((check) => check.name),
        ).toContain(name);
        expect(fixable).toContain("steps.check_pool.outputs.fixable == 'true'");
        continue;
      }
      if (signal === "self-report") {
        const pool = CHECK_POOL_JOBS.find((candidate) => candidate === job);
        const check =
          pool === undefined
            ? undefined
            : readCheckPool(pool).find((candidate) => candidate.name === name);
        expect(check, `${job}/${name}`).toBeDefined();
        if (name === "Generated files manifest guard") {
          expect(check?.run).toContain(
            "scripts/generated-files-guard.ts --guard-a",
          );
          expect(check?.run).toContain(
            "scripts/generated-files-guard.ts --guard-b",
          );
        }
        if (name === "Aggregate ownership") {
          expect(check?.run).toContain("bun run check:aggregate-locks");
        }
        expect(fixable).toContain("steps.check_pool.outputs.fixable == 'true'");
        continue;
      }
      const pooledJob = CHECK_POOL_JOBS.find((candidate) => candidate === job);
      if (signal === "code-check" && pooledJob !== undefined) {
        const check = readCheckPool(pooledJob).find(
          (candidate) => candidate.name === name,
        );
        expect(check, `${job}/${name}`).toBeDefined();
        expect(check?.run).toContain("bun run code-check");
        expect(fixable).toContain("steps.check_pool.outputs.fixable == 'true'");
        continue;
      }
      const id = text(step?.step["id"]);
      expect(id, `${job}/${name} needs an id`).not.toBe("");
      if (signal === "code-check") {
        expect(step?.run).toContain("bun run code-check");
        expect(fixable).toContain(`steps.${id}.outputs.fixable == 'true'`);
      } else {
        expect(fixable).toContain(`steps.${id}.outcome == 'failure'`);
      }
    }
  });

  test("CI dispatches autofix only after those jobs report drift", () => {
    const dispatch = ciJobs["autofix-dispatch"];
    expect(dispatch).toBeDefined();
    const needs = dispatch?.["needs"];
    expect(Array.isArray(needs)).toBe(true);
    for (const drift of new Set(AUTOFIX_DRIFT_CHECKS.map(({ job }) => job))) {
      expect(needs).toContain(drift);
    }
    const condition = text(dispatch?.["if"]);
    expect(condition).toContain("always()");
    expect(condition).toContain("github.event_name == 'pull_request'");
    expect(condition).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(condition).toContain(
      "github.event.pull_request.user.login != 'dependabot[bot]'",
    );
    expect(condition).toContain("github.actor != 'autofix-ci[bot]'");
    expect(condition).toContain("contains(needs.*.outputs.fixable, 'true')");
    expect(condition).toContain("needs.ci-checks-rest.result == 'failure'");
    const dispatches = (values: Context["values"]) =>
      evaluateWorkflowExpression(condition, {
        values: {
          "github.event_name": "pull_request",
          "github.event.pull_request.head.repo.full_name": "stella/stella",
          "github.event.pull_request.user.login": "contributor",
          "github.repository": "stella/stella",
          "github.actor": "contributor",
          "needs.*.outputs.fixable": ["true"],
          "needs.ci-checks-rest.result": "success",
          ...values,
        },
        status: {
          always: true,
          success: true,
          failure: false,
          cancelled: false,
        },
      });
    expect(dispatches({})).toBe(true);
    for (const values of [
      { "github.event_name": "push" },
      { "github.event.pull_request.head.repo.full_name": "fork/repo" },
      { "github.event.pull_request.user.login": "dependabot[bot]" },
      { "github.actor": "autofix-ci[bot]" },
      {
        "needs.*.outputs.fixable": [],
        "needs.ci-checks-rest.result": "success",
      },
    ]) {
      expect(dispatches(values)).toBe(false);
    }
    expect(dispatch?.["permissions"]).toEqual({
      actions: "write",
      contents: "read",
      "pull-requests": "read",
    });
    const dispatchSteps = workflowJobSteps(ci, "autofix-dispatch");
    const evaluate = dispatchSteps.find(
      (step) => step["name"] === "Evaluate repairable drift",
    );
    expect(text(evaluate?.["id"])).toBe("repairable");
    const evaluateEnv = evaluate?.["env"];
    expect(
      isRecord(evaluateEnv) ? text(evaluateEnv["DIRECT_FIXABLE"]) : "",
    ).toContain("contains(needs.*.outputs.fixable, 'true')");
    expect(text(evaluate?.["run"])).toContain("matrix_fixable");
    expect(text(evaluate?.["run"])).toContain(`"\${#receipts[@]}" == 2`);
    expect(text(evaluate?.["run"])).toContain("autofix-fixable-1");
    expect(text(evaluate?.["run"])).toContain("autofix-fixable-2");
    expect(text(evaluate?.["run"])).toContain("valid_receipts");
    const download = dispatchSteps.find(
      (step) => step["name"] === "Download repository-check drift receipts",
    );
    expect(text(download?.["if"])).toContain("always()");
    const downloadInputs = download?.["with"];
    expect(
      isRecord(downloadInputs) ? text(downloadInputs["pattern"]) : "",
    ).toContain(`\${{ github.run_attempt }}`);
    const fetchTooling = dispatchSteps.find(
      (step) => step["name"] === "Fetch GitHub API tooling",
    );
    expect(text(fetchTooling?.["if"])).toContain(
      "steps.repairable.outputs.fixable == 'true'",
    );
    const run = dispatchSteps.map((step) => text(step["run"])).join("\n");
    expect(run).toContain("actions/workflows/autofix.yml/dispatches");
    expect(run).toContain('-f "inputs[generator]=changed-files"');
    expect(run).toContain('-f "inputs[head]=$HEAD_SHA"');
    // A superseded head, or a branch whose own autofix workflow cannot take
    // the request, dispatches nothing.
    expect(run.indexOf('[[ "$current" != "$HEAD_SHA" ]]')).toBeLessThan(
      run.indexOf("/dispatches"),
    );
    const marker = "inputs.generator == 'changed-files'";
    expect(run.indexOf(`grep -qF "${marker}"`)).toBeLessThan(
      run.indexOf("/dispatches"),
    );
    expect(
      readFileSync(path.join(root, ".github/workflows/autofix.yml"), "utf-8"),
    ).toContain(marker);

    const restSteps = workflowJobSteps(ci, "ci-checks-rest");
    const receipt = restSteps.find(
      (step) => step["name"] === "Record autofix drift partition receipt",
    );
    const receiptEnv = receipt?.["env"];
    expect(isRecord(receiptEnv) ? text(receiptEnv["FIXABLE"]) : "").toContain(
      "steps.check_pool.outputs.fixable",
    );
    expect(isRecord(receiptEnv) ? text(receiptEnv["FIXABLE"]) : "").toContain(
      "steps.tauri_alignment.outcome == 'failure'",
    );
    expect(text(receipt?.["run"])).toContain("$PARTITION");
    const upload = restSteps.find(
      (step) => step["name"] === "Upload autofix drift partition receipt",
    );
    const uploadInputs = upload?.["with"];
    expect(isRecord(uploadInputs) ? text(uploadInputs["name"]) : "").toContain(
      `\${{ matrix.partition }}`,
    );
    expect(isRecord(uploadInputs) ? text(uploadInputs["name"]) : "").toContain(
      `\${{ github.run_attempt }}`,
    );
    const rest = ciJobs["ci-checks-rest"];
    const strategy = isRecord(rest?.["strategy"]) ? rest["strategy"] : {};
    const matrix = isRecord(strategy["matrix"]) ? strategy["matrix"] : {};
    expect(matrix["partition"]).toEqual([1, 2]);
  });

  test("receipt evaluation requires both exact valid matrix receipts", () => {
    const step = workflowJobSteps(ci, "autofix-dispatch").find(
      (candidate) => candidate["name"] === "Evaluate repairable drift",
    );
    const script = step?.["run"];
    if (typeof script !== "string") {
      throw new TypeError(
        "Autofix receipt evaluation must have a shell script",
      );
    }
    const evaluate = (
      receipts: readonly (readonly [name: string, value: string])[],
      directFixable = false,
    ) => {
      const directory = mkdtempSync(path.join(tmpdir(), "autofix-receipts-"));
      try {
        const output = path.join(directory, "github-output");
        writeFileSync(output, "");
        for (const [name, value] of receipts) {
          writeFileSync(path.join(directory, name), value);
        }
        const result = Bun.spawnSync(
          [
            "bash",
            "--noprofile",
            "--norc",
            "-e",
            "-o",
            "pipefail",
            "-c",
            script,
          ],
          {
            cwd: root,
            env: {
              PATH: process.env["PATH"] ?? "",
              DIRECT_FIXABLE: String(directFixable),
              RECEIPTS_DIR: directory,
              GITHUB_OUTPUT: output,
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        return readFileSync(output, "utf-8");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    };
    const trueFirst = [
      ["autofix-fixable-1", "true\n"],
      ["autofix-fixable-2", "false\n"],
    ] as const;
    expect(evaluate(trueFirst)).toBe("fixable=true\n");
    expect(
      evaluate([
        ["autofix-fixable-1", "false\n"],
        ["autofix-fixable-2", "true\n"],
      ]),
    ).toBe("fixable=true\n");
    expect(
      evaluate([
        ["autofix-fixable-1", "false\n"],
        ["autofix-fixable-2", "false\n"],
      ]),
    ).toBe("");
    for (const receipts of [
      [["autofix-fixable-1", "true\n"]],
      [
        ["autofix-fixable-1", "true\n"],
        ["autofix-fixable-3", "false\n"],
      ],
      [
        ["autofix-fixable-1", "true\n"],
        ["autofix-fixable-2", "false\n"],
        ["autofix-fixable-3", "false\n"],
      ],
      [
        ["autofix-fixable-1", "maybe\n"],
        ["autofix-fixable-2", "false\n"],
      ],
    ] as const) {
      expect(evaluate(receipts)).toBe("");
    }
    expect(evaluate([["autofix-fixable-1", "true\n"]], true)).toBe(
      "fixable=true\n",
    );
  });

  test("the autofix workflow runs the changed-file fix only on that request", () => {
    expect(Object.keys(PR_GENERATORS)).not.toContain("changed-files");
    expect(text(autofixJobs["regenerate-requested-files"]?.["if"])).toContain(
      "inputs.generator != 'changed-files'",
    );
    const scope = autofixJobs["regenerate-scope"];
    const condition = text(scope?.["if"]);
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
    expect(condition).toContain("inputs.generator == 'changed-files'");
    const verify = workflowJobSteps(autofix, "regenerate-scope").find(
      (step) => step["name"] === "Verify autofix request",
    );
    const verifyRun = text(verify?.["run"]);
    const scopeSteps = workflowJobSteps(autofix, "regenerate-scope");
    for (const name of [
      "Verify autofix request",
      "Fetch changed paths",
      "Find settled autofix commit",
    ]) {
      const networkStep = scopeSteps.find((step) => step["name"] === name);
      expect(Number(networkStep?.["timeout-minutes"]), name).toBeGreaterThan(0);
    }
    expect(verifyRun).toContain(".head.repo.full_name == $repository");
    expect(verifyRun).toContain('.user.login != "dependabot[bot]"');
    expect(verifyRun).toContain('("refs/heads/" + .head.ref) == $ref');
    expect(verifyRun).toContain(
      '[[ "$head" != "$REQUESTED_HEAD" || "$RUN_SHA" != "$REQUESTED_HEAD" ]]',
    );
    // Nothing in the fixing job reads the pull_request event any more.
    expect(
      JSON.stringify(autofixJobs["regenerate-derived-files"]),
    ).not.toContain("github.event");
  });
});

describe("drift signals", () => {
  test("a pooled check signals only for its own job's listed checks", () => {
    expect(poolDriftFailed("ci-checks-policy", ["Format"])).toBe(true);
    expect(poolDriftFailed("ci-checks-rest", ["Format"])).toBe(false);
    expect(
      poolDriftFailed("ci-checks-policy", ["Test subject reachability census"]),
    ).toBe(false);
    expect(
      poolDriftFailed("code-quality-web-rest", ["Aggregate ownership"]),
    ).toBe(false);
    expect(poolDriftFailed("ci-checks-rest", [])).toBe(false);
  });

  test("only changed-file autofix repairable task families signal drift", () => {
    expect(fixableCodeCheckTasks(["@stll/web#typecheck"])).toBe(false);
    expect(fixableCodeCheckTasks(["//#typecheck:repo"])).toBe(false);
    expect(fixableCodeCheckTasks(["@stll/web#test"])).toBe(false);
    expect(fixableCodeCheckTasks(["bun run env:check"])).toBe(true);
    expect(fixableCodeCheckTasks(["@stll/api#lint"])).toBe(true);
    expect(
      fixableCodeCheckTasks([
        "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --type-aware --type-check scripts/example.ts",
      ]),
    ).toBe(true);
    expect(
      fixableCodeCheckTasks(["@stll/web#typecheck", "@stll/web#lint"]),
    ).toBe(true);
    expect(fixableCodeCheckTasks(["bash scripts/lint-root-scripts.sh"])).toBe(
      true,
    );
    expect(fixableCodeCheckTasks(["bun run assets:check"])).toBe(false);
    expect(fixableCodeCheckTasks(["bun run lint:css"])).toBe(false);
    expect(
      fixableCodeCheckTasks(["bash scripts/lint-oxlint-fixtures.sh"]),
    ).toBe(false);
    expect(fixableCodeCheckTasks(["bun scripts/unknown-check.ts"])).toBe(false);
    expect(
      fixableCodeCheckTasks(["bun scripts/check-oxlint-rule-decisions.ts"]),
    ).toBe(false);
    expect(fixableCodeCheckTasks([])).toBe(false);
  });

  test("the produced rule-decision check does not request changed-file autofix", () => {
    const plan = planCheck({
      changedPaths: ["scripts/check-oxlint-rule-decisions.ts"],
      presentChangedPaths: ["scripts/check-oxlint-rule-decisions.ts"],
      repositoryPaths: ["scripts/check-oxlint-rule-decisions.ts"],
      affectedWorkspacePaths: [],
      workspacePaths: new Set(),
    });
    expect(plan.type).toBe("scoped");
    if (plan.type === "fallback") {
      return;
    }
    const task = scopedCommands(plan).find(
      (command) => command.at(1) === "scripts/check-oxlint-rule-decisions.ts",
    );
    expect(task).toEqual(["bun", "scripts/check-oxlint-rule-decisions.ts"]);
    if (task === undefined) {
      return;
    }
    const directory = mkdtempSync(
      path.join(tmpdir(), "code-check-rule-output-"),
    );
    try {
      const output = path.join(directory, "output");
      writeFileSync(output, "");
      const command = task.join(" ");
      recordFixableFailure(
        {
          command,
          exitCode: 1,
          tasks: [{ task: command, errors: [] }],
        },
        output,
      );
      expect(readFileSync(output, "utf-8")).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("code-check records only a fixable failure, never a false", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "code-check-output-"));
    try {
      const output = path.join(directory, "output");
      const summary = (tasks: string[]) => ({
        command: "bun --bun turbo run lint typecheck",
        exitCode: 1,
        tasks: tasks.map((task) => ({ task, errors: [] })),
      });
      recordFixableFailure(summary(["@stll/web#typecheck"]), output);
      expect(Bun.file(output).size).toBe(0);
      recordFixableFailure(summary(["@stll/api#lint"]), output);
      expect(readFileSync(output, "utf-8")).toBe("fixable=true\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
