import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PRUNABLE_BASELINE_WRITERS } from "./autofix-baseline-prune";
import {
  AUTOFIX_DRIFT_CHECKS,
  fixableCodeCheckTasks,
  poolDriftFailed,
} from "./autofix-drift-checks";
import { CHECK_POOL_JOBS, readCheckPool } from "./ci-check-pool-registry";
import { recordFixableFailure } from "./code-check-affected";
import { GENERATORS } from "./generated-files";
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

/** Every step of every CI job, pooled checks included, keyed `job/name`. */
const ciSteps = Object.keys(ciJobs).flatMap((job) =>
  "steps" in (ciJobs[job] ?? {})
    ? workflowJobSteps(ci, job).map((step) => ({
        job,
        name: text(step["name"]),
        run: text(step["run"]),
        step,
      }))
    : [],
);
const stepsRunning = (matches: (line: string) => boolean) =>
  ciSteps
    .filter(({ run }) => run.split("\n").some((line) => matches(line.trim())))
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
        (line) => line.includes("turbo run format") && line.includes("--check"),
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
      const script = write[1] ?? "";
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
    expect(dispatch?.["permissions"]).toEqual({
      actions: "write",
      contents: "read",
      "pull-requests": "read",
    });
    const run = workflowJobSteps(ci, "autofix-dispatch")
      .map((step) => text(step["run"]))
      .join("\n");
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
    expect(poolDriftFailed("ci-checks-rest", [])).toBe(false);
  });

  test("a failed typecheck alone is not fixable; lint and root lint are", () => {
    expect(fixableCodeCheckTasks(["@stll/web#typecheck"])).toBe(false);
    expect(fixableCodeCheckTasks(["//#typecheck:repo"])).toBe(false);
    expect(fixableCodeCheckTasks(["@stll/api#lint"])).toBe(true);
    expect(
      fixableCodeCheckTasks(["@stll/web#typecheck", "@stll/web#lint"]),
    ).toBe(true);
    expect(fixableCodeCheckTasks(["bash scripts/lint-root-scripts.sh"])).toBe(
      true,
    );
    expect(fixableCodeCheckTasks([])).toBe(false);
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
