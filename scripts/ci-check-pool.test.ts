import { expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import {
  blockingFailures,
  continueOnErrorHolds,
  planChecks,
  poolContext,
  processLauncher,
  resolveEnv,
  runChecks,
  summaryTable,
  type CheckResult,
  type Launched,
  type PlannedCheck,
} from "./ci-check-pool";
import {
  CHECK_POOL_JOBS,
  CHECK_POOL_STEP_NAMES,
  checkPoolJob,
  parseCheckPool,
  readCheckPool,
  type PoolCheck,
} from "./ci-check-pool-registry";
import { ROOT_CHECK_INPUTS } from "./ci-root-checks";
import { flattenWorkflowSteps, workflowJobSteps } from "./workflow-steps";

const root = path.resolve(import.meta.dir, "..");
const workflow: unknown = Bun.YAML.parse(
  readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
);

const check = (name: string, extra: Partial<PoolCheck> = {}): PoolCheck => ({
  name,
  id: undefined,
  condition: "true",
  run: "true",
  env: {},
  timeoutMinutes: undefined,
  continueOnError: undefined,
  step: { name },
  ...extra,
});

test("each pooled job runs its registry from exactly one pool step", () => {
  for (const job of CHECK_POOL_JOBS) {
    const steps = workflowJobSteps(workflow, job);
    const pools = steps.filter((step) => checkPoolJob(step) !== undefined);
    expect(pools.map((step) => [step["name"], checkPoolJob(step)])).toEqual([
      [CHECK_POOL_STEP_NAMES[job], job],
    ]);
    // Guards see every pooled check as a step of the job, right after the pool.
    const index = steps.indexOf(pools[0] ?? {});
    const pooled = readCheckPool(job).map(({ name }) => name);
    expect(
      steps.slice(index + 1, index + 1 + pooled.length).map(({ name }) => name),
    ).toEqual(pooled);
  }
});

test("every pooled check declares its classification and selection inputs", () => {
  for (const job of CHECK_POOL_JOBS) {
    const inputs = ROOT_CHECK_INPUTS[job];
    for (const pooled of readCheckPool(job)) {
      expect(inputs[pooled.name], `${job}/${pooled.name}`).toBeArray();
      const kind = pooled.env["CI_CHECK_KIND"] ?? "";
      expect(["STATIC", "CONTEXTUAL"], pooled.name).toContain(kind);
    }
  }
});

test("the registry rejects fields the pool cannot honour", () => {
  const entry = (fields: string) =>
    `checks:\n  - name: A\n    if: \${{ true }}\n    run: echo\n${fields}`;
  expect(parseCheckPool(entry(""))).toHaveLength(1);
  for (const field of [
    "    uses: actions/checkout@v4\n",
    "    background: true\n",
    "    shell: sh\n",
    "    timeout-minutes: 0\n",
  ]) {
    expect(() => parseCheckPool(entry(field))).toThrow(
      /unsupported fields|timeout-minutes/u,
    );
  }
  expect(() =>
    parseCheckPool(`${entry("")}  - name: A\n    if: x\n    run: y\n`),
  ).toThrow("unique");
  expect(() => parseCheckPool(entry("    continue-on-error: 1\n"))).toThrow(
    "invalid continue-on-error",
  );
  // Guards read the entry as a step, so they see its continue-on-error too.
  const queueOnly = `\${{ github.event_name == 'merge_group' }}`;
  const lenient = entry(`    continue-on-error: ${queueOnly}\n`);
  expect(parseCheckPool(lenient)[0]).toMatchObject({
    continueOnError: queueOnly,
    step: { "continue-on-error": queueOnly },
  });
});

const context = (event: string, rootChecks: string, steps = {}) =>
  poolContext({
    github: {
      event_name: event,
      base_ref: event === "pull_request" ? "main" : "",
      repository: "owner/name",
      token: "token",
      event:
        event === "pull_request"
          ? { pull_request: { number: 7, base: { sha: "base" } } }
          : { merge_group: { base_sha: "queue", head_ref: "refs/x" } },
    },
    needs: {
      "ci-plan": {
        outputs: {
          package_checks_required: "true",
          root_checks: rootChecks,
        },
      },
    },
    steps: {
      checkout: { outcome: "success", outputs: {} },
      install: { outcome: "success", outputs: {} },
      affected: { outcome: "success", outputs: { flag: "--affected" } },
      ...steps,
    },
  });

test("pooled conditions keep change selection, receipt reuse and event gates", () => {
  const rest = readCheckPool("ci-checks-rest");
  const policy = readCheckPool("ci-checks-policy");
  const selected = (planned: PlannedCheck[]) =>
    planned.flatMap((entry) => {
      expect(entry.status, entry.check.name).not.toBe("invalid");
      return entry.status === "selected" ? [entry.check.name] : [];
    });
  const narrow = JSON.stringify(["ci-checks-rest/Test oxlint plugins"]);
  const pr = selected(planChecks(rest, context("pull_request", narrow)));
  expect(pr).toContain("Test oxlint plugins");
  expect(pr).not.toContain("Content delivery declarations");
  // Unscoped ("**") checks have no selection gate and always run.
  expect(pr).toContain("Workflow YAML");
  const queue = selected(planChecks(rest, context("merge_group", "")));
  expect(queue).toContain("Content delivery declarations");
  expect(queue).not.toContain("Bridge-version guard");
  const reused = selected(
    planChecks(
      policy,
      context("push", "", {
        static_receipts: { outputs: { reuse_static_check_001: "true" } },
      }),
    ),
  );
  expect(reused).not.toContain("Test unsignalled skip detection");
  expect(reused).toContain("Ratchet scanner invariants");
});

const EXPRESSION = (body: string) => `\${{ ${body} }}`;

test("pooled env values render like step env", () => {
  const pr = context("pull_request", "");
  const queue = context("merge_group", "");
  const env = {
    BASE_SHA: EXPRESSION(
      "github.event.pull_request.base.sha || github.event.merge_group.base_sha || ''",
    ),
    CHECK_BASE_REF: EXPRESSION(
      "format('origin/{0}', github.base_ref || 'main')",
    ),
    PULL_REQUEST_NUMBER: EXPRESSION("github.event.pull_request.number"),
    AFFECTED_FLAG: EXPRESSION("steps.affected.outputs.flag"),
    STELLA_VERIFY: "check",
  };
  expect(resolveEnv(env, pr)).toEqual({
    BASE_SHA: "base",
    CHECK_BASE_REF: "origin/main",
    PULL_REQUEST_NUMBER: "7",
    AFFECTED_FLAG: "--affected",
    STELLA_VERIFY: "check",
  });
  expect(resolveEnv(env, queue)).toMatchObject({
    BASE_SHA: "queue",
    CHECK_BASE_REF: "origin/main",
    PULL_REQUEST_NUMBER: "",
  });
  expect(() => resolveEnv({ X: `a-${EXPRESSION("github.ref")}` }, pr)).toThrow(
    "embedded expressions unsupported",
  );
  // Every real pooled env value renders in both events.
  for (const job of CHECK_POOL_JOBS) {
    for (const pooled of readCheckPool(job)) {
      expect(() => resolveEnv(pooled.env, pr)).not.toThrow();
      expect(() => resolveEnv(pooled.env, queue)).not.toThrow();
    }
  }
});

test("the pool bounds concurrency, reports in order and reports every failure", async () => {
  await assertProperty(
    "the pool bounds concurrency, reports in order and reports every failure",
    fc.asyncProperty(
      fc.array(
        fc.record({
          status: fc.constantFrom("selected", "skipped", "invalid"),
          fails: fc.boolean(),
          delay: fc.nat({ max: 3 }),
        }),
        { maxLength: 12 },
      ),
      fc.integer({ min: 1, max: 5 }),
      async (entries, concurrency) => {
        const planned: PlannedCheck[] = entries.map((entry, index) => {
          const pooled = check(`check ${index}`);
          if (entry.status === "selected") {
            return {
              check: pooled,
              status: "selected",
              env: {},
              continueOnError: false,
            };
          }
          return entry.status === "skipped"
            ? { check: pooled, status: "skipped" }
            : { check: pooled, status: "invalid", message: "bad" };
        });
        let running = 0;
        let peak = 0;
        const reported: number[] = [];
        const results = await runChecks({
          planned,
          concurrency,
          report: (index) => {
            reported.push(index);
          },
          launch: async (index): Promise<Launched> => {
            running += 1;
            peak = Math.max(peak, running);
            for (let tick = 0; tick < (entries[index]?.delay ?? 0); tick++) {
              await Promise.resolve();
            }
            running -= 1;
            return {
              exitCode: entries[index]?.fails === true ? 1 : 0,
              timedOut: false,
              maxRssBytes: undefined,
            };
          },
        });
        expect(peak).toBeLessThanOrEqual(concurrency);
        expect(reported).toEqual(entries.map((_, index) => index));
        const expected = entries.map((entry): CheckResult["outcome"] => {
          if (entry.status === "skipped") {
            return "skipped";
          }
          return entry.status === "invalid" || entry.fails
            ? "failure"
            : "success";
        });
        expect(results.map(({ outcome }) => outcome)).toEqual(expected);
      },
    ),
  );
});

test("a launched check runs as a bash step with its env, output and timeout", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-check-pool-"));
  try {
    const launch = processLauncher({ root, directory });
    const passed = await launch(
      0,
      check("passes", { run: 'echo "out $POOL_VALUE"\necho err >&2\n' }),
      { POOL_VALUE: "set" },
    );
    expect(passed).toMatchObject({ exitCode: 0, timedOut: false });
    expect(readFileSync(path.join(directory, "000.log"), "utf-8")).toBe(
      "out set\nerr\n",
    );
    // `-eo pipefail`, as for a `shell: bash` step.
    const failed = await launch(
      1,
      check("fails", { run: "false | true\necho unreachable\n" }),
      {},
    );
    expect(failed.exitCode).not.toBe(0);
    expect(readFileSync(path.join(directory, "001.log"), "utf-8")).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("flattening steps that already carry their pooled checks adds none", () => {
  for (const job of CHECK_POOL_JOBS) {
    const steps = workflowJobSteps(workflow, job);
    expect(flattenWorkflowSteps(steps).map(({ name }) => name)).toEqual(
      steps.map(({ name }) => name),
    );
  }
});

test("the summary table keeps one row per check whatever a failure says", () => {
  const table = summaryTable([
    {
      name: "A | B",
      id: undefined,
      outcome: "failure",
      continuedOnError: false,
      detail: "exit code 1\nsee a|b \\ c",
      seconds: 1.25,
      maxRssBytes: 2 * 1_048_576,
    },
    {
      name: "C",
      id: undefined,
      outcome: "skipped",
      continuedOnError: false,
      detail: "condition false",
      seconds: 0,
      maxRssBytes: undefined,
    },
  ]).split("\n");
  expect(table).toHaveLength(4);
  expect(table[2]).toBe(
    String.raw`| A \| B | failure: exit code 1 see a\|b \\ c | 1.3 | 2 |`,
  );
  expect(table[3]).toBe("| C | skipped |  |  |");
});

test("continue-on-error lets a failed check pass the pool only when it holds", async () => {
  const queue = context("merge_group", "");
  const pr = context("pull_request", "");
  const lenient = EXPRESSION("github.event_name == 'merge_group'");
  const run = async (declared: PoolCheck["continueOnError"], at = queue) =>
    runChecks({
      planned: planChecks([check("fails", { continueOnError: declared })], at),
      concurrency: 1,
      report: () => undefined,
      launch: async (): Promise<Launched> => ({
        exitCode: 1,
        timedOut: false,
        maxRssBytes: undefined,
      }),
    });
  const continued = await run(lenient);
  expect(continued[0]).toMatchObject({
    outcome: "failure",
    continuedOnError: true,
  });
  expect(blockingFailures(continued)).toEqual([]);
  expect(blockingFailures(await run(true))).toEqual([]);
  // False, absent, or an expression that does not hold: the failure blocks.
  for (const results of [
    await run(lenient, pr),
    await run(false),
    await run(undefined),
  ]) {
    expect(results[0]?.continuedOnError).toBe(false);
    expect(blockingFailures(results)).toHaveLength(1);
  }
});

test("an undecidable continue-on-error fails closed", async () => {
  const queue = context("merge_group", "");
  // `failure()` is a status function the pool cannot decide.
  const unknown = EXPRESSION("failure()");
  expect(continueOnErrorHolds(unknown, queue)).toBe(false);
  expect(continueOnErrorHolds(EXPRESSION("("), queue)).toBe(false);
  const results = await runChecks({
    planned: planChecks([check("fails", { continueOnError: unknown })], queue),
    concurrency: 1,
    report: () => undefined,
    launch: async (): Promise<Launched> => ({
      exitCode: 1,
      timedOut: false,
      maxRssBytes: undefined,
    }),
  });
  expect(blockingFailures(results)).toHaveLength(1);
});

test("every real pooled continue-on-error is decidable in both events", () => {
  for (const job of CHECK_POOL_JOBS) {
    for (const pooled of readCheckPool(job)) {
      if (typeof pooled.continueOnError !== "string") {
        continue;
      }
      expect(
        continueOnErrorHolds(
          pooled.continueOnError,
          context("merge_group", ""),
        ),
        pooled.name,
      ).toBe(true);
      expect(
        continueOnErrorHolds(
          pooled.continueOnError,
          context("pull_request", ""),
        ),
        pooled.name,
      ).toBe(false);
    }
  }
});
