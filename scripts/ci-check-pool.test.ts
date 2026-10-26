import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import {
  blockingFailures,
  checkLogText,
  type CheckResult,
  conditionHolds,
  continueOnErrorHolds,
  failedCheckAnnotation,
  finishedCheckLine,
  jobStartedAt,
  jobTimeout,
  type Launched,
  partitionChecks,
  planChecks,
  type PlannedCheck,
  POOL_CONTEXT_ROOTS,
  POOL_DEADLINE_MARGIN_MINUTES,
  poolContext,
  poolDeadline,
  processLauncher,
  resolveEnv,
  runChecks,
  selectChecks,
  stillRunningLines,
  summaryTable,
} from "./ci-check-pool";
import {
  CHECK_POOL_JOBS,
  CHECK_POOL_STEP_NAMES,
  checkPoolJob,
  checkPoolStepRun,
  parseCheckPool,
  type PoolCheck,
  readCheckPool,
} from "./ci-check-pool-registry";
import { ROOT_CHECK_INPUTS } from "./ci-root-checks";
import { evaluate, type Value } from "./github-expression";
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
  timeoutMinutes: 1,
  continueOnError: undefined,
  step: { name },
  ...extra,
});

test("an exact named subset retains manifest order", () => {
  const checks = [check("First"), check("Second"), check("Third")];
  expect(selectChecks(checks, "Third,First").map(({ name }) => name)).toEqual([
    "First",
    "Third",
  ]);
  expect(selectChecks(checks, undefined)).toEqual(checks);
  expect(() => selectChecks(checks, "First,Missing")).toThrow(
    "Unknown check name(s): Missing",
  );
});

test("matrix partitions cover every pooled check exactly once", () => {
  const checks = [check("First"), check("Second"), check("Third")];
  const selected = ["1/2", "2/2"].flatMap((partition) =>
    partitionChecks(checks, partition),
  );
  expect(selected.map(({ name }) => name).toSorted()).toEqual(
    checks.map(({ name }) => name).toSorted(),
  );
  expect(new Set(selected).size).toBe(checks.length);
  expect(() => partitionChecks(checks, "3/2")).toThrow(
    "CI_CHECK_POOL_PARTITION must have the form <index>/<count>",
  );
});

test("failed checks emit one annotation with their first actionable cause", () => {
  const result = { name: "Unit tests", detail: "exit code 1" };
  // Bun prints a test's error before its (fail) line; a later test's error is
  // not the first failure's cause.
  expect(
    failedCheckAnnotation(
      result,
      "(pass) earlier\nerror: expected A\n(fail) test A\nerror: expected B\n(fail) test B",
    ),
  ).toBe(
    "::error title=FAILED check%3A Unit tests::(fail) test A -- error: expected A",
  );
  // Output after the marker belongs to the next test, so a failed test
  // without its own diagnostic is named alone.
  expect(
    failedCheckAnnotation(
      result,
      "(pass) earlier\n(fail) parser > rejects invalid input\ntrace\nerror: expected a value\n(fail) later",
    ),
  ).toBe(
    "::error title=FAILED check%3A Unit tests::(fail) parser > rejects invalid input",
  );
  expect(
    failedCheckAnnotation(result, "loading\nERROR: compiler stopped"),
  ).toBe("::error title=FAILED check%3A Unit tests::ERROR: compiler stopped");
  expect(failedCheckAnnotation(result, "loading\nno diagnostic")).toBe(
    "::error title=FAILED check%3A Unit tests::exit code 1",
  );
});

test("a check that passes its own tests reports its first finding, never a passing test", () => {
  const result = { name: "CI network step retries and timeouts", detail: "x" };
  expect(
    failedCheckAnnotation(
      result,
      [
        "bun test v1.4.3 (c6da4a4d3)",
        "",
        "::group::scripts/check-ci-network-steps.test.ts:",
        "(pass) shell detection > curl with its own retry-all-errors budget counts as retried [0.09ms]",
        "(pass) allowlist > every entry needs a reason [1.10ms]",
        "::endgroup::",
        "",
        " 43 pass",
        " 0 fail",
        " 46 expect() calls",
        "Ran 43 tests across 1 file. [119.00ms]",
        ".github/actions/build-web-image/action.yml: Report carried web asset and image sizes: route docker pull through scripts/retry.sh",
        ".github/workflows/release.yml: prepare-web-image: docker pull needs a step timeout-minutes",
      ].join("\n"),
    ),
  ).toBe(
    "::error title=FAILED check%3A CI network step retries and timeouts::.github/actions/build-web-image/action.yml: Report carried web asset and image sizes: route docker pull through scripts/retry.sh",
  );
  // A finding is named by its path, even one with a line and no extension.
  expect(
    failedCheckAnnotation(
      { name: "Ratchet guard", detail: "x" },
      "bun test v1.4.3 (c6da4a4d3)\n(pass) ratchet > counts [1ms]\napps/web/Dockerfile:15: uncataloged env PREVIOUS_WEB_IMAGE\nerror: script exited with code 1",
    ),
  ).toBe(
    "::error title=FAILED check%3A Ratchet guard::apps/web/Dockerfile:15: uncataloged env PREVIOUS_WEB_IMAGE",
  );
  // A word that merely contains "error" is not an error line.
  expect(
    failedCheckAnnotation(
      { name: "Policy", detail: "exit code 1" },
      "(pass) retry-all-errors budget [1ms]\nchecking mirrors\nnothing matched",
    ),
  ).toBe("::error title=FAILED check%3A Policy::exit code 1");
});

test("failed check annotations escape and truncate their messages", () => {
  const cause = `error: 100%\rnext${"x".repeat(600)}`;
  const annotation = failedCheckAnnotation(
    { name: "Policy, checks", detail: "exit code 2" },
    cause,
  );
  expect(annotation).toStartWith(
    "::error title=FAILED check%3A Policy%2C checks::error: 100%25",
  );
  expect(annotation).toContain("%0Dnext");
  const message = annotation.slice(annotation.indexOf("::", 2) + 2);
  expect(
    message
      .replaceAll("%0A", "\n")
      .replaceAll("%0D", "\r")
      .replaceAll("%25", "%"),
  ).toHaveLength(500);
  expect(
    failedCheckAnnotation(
      { name: "Fallback", detail: "exit%\r\ncode 2" },
      "no diagnostic",
    ),
  ).toEndWith("::exit%25%0D%0Acode 2");
});

test("each pooled job runs its registry from exactly one pool step", () => {
  for (const job of CHECK_POOL_JOBS) {
    const steps = workflowJobSteps(workflow, job);
    const pools = steps.filter((step) => checkPoolJob(step) !== undefined);
    expect(pools.map((step) => [step["name"], checkPoolJob(step)])).toEqual([
      [CHECK_POOL_STEP_NAMES[job], job],
    ]);
    expect(pools.at(0)?.["run"]).toBe(checkPoolStepRun(job));
    expect(checkPoolJob({ run: checkPoolStepRun(job) })).toBe(job);
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
  const unbounded = (fields: string) =>
    `checks:\n  - name: A\n    if: \${{ true }}\n    run: echo\n${fields}`;
  const entry = (fields: string) =>
    unbounded(`    timeout-minutes: 1\n${fields}`);
  expect(parseCheckPool(entry(""))).toHaveLength(1);
  for (const field of [
    "    uses: actions/checkout@v4\n",
    "    background: true\n",
    "    shell: sh\n",
  ]) {
    expect(() => parseCheckPool(entry(field))).toThrow("unsupported fields");
  }
  // Every check is bounded: no budget, or one that is no whole minute, fails
  // with the fix in the message.
  for (const timeout of [
    "",
    "    timeout-minutes: 0\n",
    "    timeout-minutes: 1.5\n",
  ]) {
    expect(() => parseCheckPool(unbounded(timeout))).toThrow(
      "A: declare timeout-minutes, a whole number of minutes (at least 1) that bounds the check; size it at about 2.5x its worst duration in the pool's summary table",
    );
  }
  expect(() =>
    parseCheckPool(
      `${entry("")}  - name: A\n    if: x\n    run: y\n    timeout-minutes: 1\n`,
    ),
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

type ContextExtra = {
  inputs?: Value;
  outputs?: Record<string, string>;
};
const context = (
  event: string,
  rootChecks: string,
  steps = {},
  { inputs = null, outputs = {} }: ContextExtra = {},
) =>
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
          ...outputs,
        },
      },
    },
    steps: {
      checkout: { outcome: "success", outputs: {} },
      install: { outcome: "success", outputs: {} },
      affected: { outcome: "success", outputs: { flag: "--affected" } },
      ...steps,
    },
    inputs,
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
  // A scoped check runs only when root_checks names it (or is empty).
  expect(pr).not.toContain("Workflow YAML");
  // Unscoped checks have no selection gate and always run.
  expect(pr).toContain("Queue authority");
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

test("an unset root check selection keeps every pooled check, as GitHub reads it", () => {
  // A main PR-depth run whose planner was unavailable writes no root_checks
  // output, so toJSON(needs) omits the key. GitHub evaluates the selection
  // gate `root_checks == ''` as true for the unset output; the pool must
  // agree, or main skips the checks every pull request then inherits as red.
  for (const job of CHECK_POOL_JOBS) {
    const checks = readCheckPool(job);
    const names = (rootChecks: Value | undefined) =>
      planChecks(
        checks,
        poolContext({
          github: { event_name: "workflow_dispatch", ref: "refs/heads/main" },
          needs: {
            "ci-plan": {
              outputs: {
                package_checks_required: "true",
                ...(rootChecks === undefined
                  ? {}
                  : { root_checks: rootChecks }),
              },
            },
          },
          steps: {
            checkout: { outcome: "success", outputs: {} },
            install: { outcome: "success", outputs: {} },
          },
          inputs: { depth: "fast", heavy_only: false, pr_depth_only: true },
        }),
      ).flatMap((entry) =>
        entry.status === "selected" ? [entry.check.name] : [],
      );
    const all = JSON.stringify(
      Object.keys(ROOT_CHECK_INPUTS[job]).map((name) => `${job}/${name}`),
    );
    expect(names(undefined), job).toEqual(names(""));
    expect(names(undefined), job).toEqual(names(all));
  }
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

test("a check that outlives its budget is killed with its children and named as timed out", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-check-pool-budget-"));
  const pidFile = path.join(directory, "child.pid");
  try {
    // One budget minute lasts 300 ms here; the check sleeps for 60 s.
    const launch = processLauncher({ root, directory, minuteMs: 300 });
    const hung = check("Hung check", {
      run: 'echo started\nsleep 60 &\necho $! > "$FIXTURE_CHILD_PID"\nwait\n',
      timeoutMinutes: 1,
    });
    const finished: string[] = [];
    const startedAt = performance.now();
    const [result] = await runChecks({
      planned: [
        {
          check: hung,
          status: "selected",
          env: { FIXTURE_CHILD_PID: pidFile },
          continueOnError: false,
        },
      ],
      concurrency: 1,
      launch,
      report: () => undefined,
      finished: (_index, ended) => {
        finished.push(finishedCheckLine(ended));
      },
    });
    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(result).toMatchObject({
      outcome: "failure",
      detail: "timed out after 1 min",
    });
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatch(
      /^Finished check: Hung check \(failure: timed out after 1 min, \d+\.\ds\)$/u,
    );
    expect(readFileSync(path.join(directory, "000.log"), "utf-8")).toBe(
      "started\n",
    );
    // The budget kills the check's whole process group, not only its shell.
    const pid = readFileSync(pidFile, "utf-8").trim();
    expect(pid).toMatch(/^[1-9]\d*$/u);
    const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", pid]);
    expect(new TextDecoder().decode(state.stdout).trim()).toMatch(/^Z.*$|^$/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the live line names each check's outcome and time as it ends", () => {
  const base = {
    id: undefined,
    continuedOnError: false,
    seconds: 12.345,
    maxRssBytes: undefined,
  };
  expect(
    finishedCheckLine({
      ...base,
      name: "Lint",
      outcome: "success",
      detail: "passed",
    }),
  ).toBe("Finished check: Lint (success, 12.3s)");
  expect(
    finishedCheckLine({
      ...base,
      name: "Lint",
      outcome: "failure",
      continuedOnError: true,
      detail: "exit code 2",
    }),
  ).toBe(
    "Finished check: Lint (failure (continue-on-error): exit code 2, 12.3s)",
  );
  expect(
    stillRunningLines(
      new Map([
        [0, { name: "Done", status: "completed" as const, started: 0 }],
        [1, { name: "Hung", status: "running" as const, started: 1000 }],
      ]),
      62_500,
    ),
  ).toEqual(["Still running: Hung (61.5 s)"]);
});

test("every job that runs the pool declares a timeout the pool's deadline fits under", () => {
  for (const job of CHECK_POOL_JOBS) {
    const timeout = jobTimeout({
      root,
      poolJob: job,
      // A caller of ci.yml names itself in GITHUB_WORKFLOW_REF; the pooled
      // job is still read from ci.yml.
      env: {
        GITHUB_JOB: job,
        GITHUB_WORKFLOW_REF:
          "stella/stella/.github/workflows/main-pr-depth.yml@refs/heads/main",
      },
    });
    expect(timeout?.workflow).toBe(".github/workflows/ci.yml");
    expect(timeout?.minutes).toBeGreaterThan(POOL_DEADLINE_MARGIN_MINUTES);
  }
  // Another workflow's job that runs a pool reads its own workflow.
  expect(
    jobTimeout({
      root,
      poolJob: "ci-checks-rest",
      env: {
        GITHUB_JOB: "admission",
        GITHUB_WORKFLOW_REF:
          "stella/stella/.github/workflows/queue-admission.yml@refs/heads/main",
      },
    }),
  ).toMatchObject({ workflow: ".github/workflows/queue-admission.yml" });
  expect(
    jobTimeout({ root, poolJob: "ci-checks-rest", env: {} }),
  ).toBeUndefined();
  expect(() =>
    jobTimeout({
      root,
      poolJob: "ci-checks-rest",
      env: {
        GITHUB_JOB: "missing-job",
        GITHUB_WORKFLOW_REF:
          "stella/stella/.github/workflows/ci.yml@refs/heads/main",
      },
    }),
  ).toThrow(
    ".github/workflows/ci.yml: job missing-job must declare a literal timeout-minutes above 3",
  );
});

test("the deadline counts from the job's start and falls back to the pool's start only later", () => {
  const minute = 60_000;
  const pool = 100 * minute;
  // The event file, written as the job is set up, marks the job's start.
  expect(
    jobStartedAt({
      eventWrittenAt: pool - 2 * minute,
      poolStartedAt: pool,
      timeoutMinutes: 40,
    }),
  ).toBe(pool - 2 * minute);
  // A time the job cannot have started at never moves the deadline earlier.
  for (const eventWrittenAt of [undefined, pool + minute, pool - 41 * minute]) {
    expect(
      jobStartedAt({ eventWrittenAt, poolStartedAt: pool, timeoutMinutes: 40 }),
    ).toBe(pool);
  }
  expect(poolDeadline(pool, 40)).toBe(
    pool + (40 - POOL_DEADLINE_MARGIN_MINUTES) * minute,
  );
});

test("a pool entry without a budget is refused by the workflow-steps guard too", () => {
  const unbounded = () =>
    `checks:\n  - name: Unbounded\n    if: \${{ true }}\n    run: sleep 600\n`;
  expect(() =>
    flattenWorkflowSteps(
      [
        {
          name: "Run repository checks",
          run: checkPoolStepRun("ci-checks-rest"),
        },
      ],
      unbounded,
    ),
  ).toThrow("Unbounded: declare timeout-minutes");
});

// timeout: The signal fixture has a 10 s child watchdog; allow its forced
// cleanup to finish before the outer test can terminate.
test("cancellation retains bounded running and buffered failure diagnostics and stops children", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-check-pool-cancel-"));
  const scripts = path.join(directory, "scripts");
  const registry = path.join(directory, ".github/ci-checks");
  mkdirSync(scripts);
  mkdirSync(registry, { recursive: true });
  for (const file of [
    "ci-check-pool.ts",
    "ci-check-pool-registry.ts",
    "github-expression.ts",
  ]) {
    copyFileSync(path.join(root, "scripts", file), path.join(scripts, file));
  }
  const fifo = path.join(directory, "ready.fifo");
  const pidFile = path.join(directory, "child.pid");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  writeFileSync(path.join(directory, "needs.json"), "{}");
  writeFileSync(
    path.join(registry, "ci-checks-rest.yml"),
    Bun.YAML.stringify({
      checks: [
        {
          name: "Blocked first",
          run: [
            `printf '%s\\n' discarded-prefix '${"x".repeat(20 * 1024)}' 'Checking fixture-generator'`,
            "sleep 600 &",
            'echo $! > "$FIXTURE_CHILD_PID"',
            'printf "ready\\n" > "$FIXTURE_READY_FIFO"',
            "wait",
          ].join("\n"),
          env: { FIXTURE_CHILD_PID: pidFile, FIXTURE_READY_FIFO: fifo },
        },
        {
          name: "Buffered failure",
          run: 'read -r ready < "$FIXTURE_READY_FIFO"\necho "::error::buffered fixture failure"\nexit 1',
          env: { FIXTURE_READY_FIFO: fifo },
        },
        // Long lines: each tail fills its byte cap before its line cap.
        ...Array.from({ length: 9 }, (_, index) => ({
          name: `Buffered log ${index}`,
          run: `printf '%s\\n' '${`${index % 2 === 0 ? "x".repeat(1024) : "é🙂".repeat(400)}\n`.repeat(20)}'`,
        })),
        { name: "Later check", run: "sleep 600" },
      ].map((entry) => ({ ...entry, if: "true", "timeout-minutes": 10 })),
    }),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(scripts, "ci-check-pool.ts"),
      "run",
      "ci-checks-rest",
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env["PATH"] ?? "",
        RUNNER_TEMP: directory,
        CI_CHECK_POOL_CONCURRENCY: "2",
        CI_CHECK_POOL_NEEDS_FILE: path.join(directory, "needs.json"),
        CI_CHECK_POOL_STEPS: "{}",
        CI_CHECK_POOL_INPUTS: "{}",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    },
  );
  const stderr = new Response(child.stderr).text();
  let output = "";
  let status: "waiting" | "signalled" = "waiting";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of child.stdout) {
      output += decoder.decode(chunk, { stream: true });
      if (
        status === "waiting" &&
        output.includes("Starting check: Later check")
      ) {
        // The FIFO proves the first log was written; worker reuse proves the
        // second check settled, while registry ordering still holds its log.
        expect(output).not.toContain("::group::Buffered failure");
        child.kill("SIGTERM");
        status = "signalled";
      }
    }
    output += decoder.decode();
    expect(await stderr).toBe("");
    expect(status).toBe("signalled");
    expect(await child.exited).toBe(130);
    expect(output).toContain("Received SIGTERM: stopping the check pool.");
    expect(output).toMatch(/^Still running: Blocked first \(\d+\.\d s\)$/mu);
    expect(output).toMatch(
      /Interrupted check: Blocked first \(running for \d+\.\d s\)/u,
    );
    // A check that ended prints its live line before registry order allows
    // its log.
    expect(output).toMatch(
      /^Finished check: Buffered failure \(failure: exit code 1, \d+\.\ds\)$/mu,
    );
    expect(output).toContain("| Checking fixture-generator");
    expect(output).toContain("Interrupted check: Buffered failure (completed)");
    expect(output).toContain("| ::error::buffered fixture failure");
    expect(output).not.toContain("discarded-prefix");
    expect(output).not.toMatch(/^::error::buffered fixture failure$/mu);
    expect(output).toContain(
      "Log tail omitted: cancellation output limit reached.",
    );
    const diagnostics = output.slice(
      output.indexOf("::group::Interrupted check:"),
    );
    expect(diagnostics).toContain("é🙂");
    expect(diagnostics).toContain("�");
    expect(Buffer.byteLength(diagnostics)).toBeLessThanOrEqual(64 * 1024);
    expect([...diagnostics.matchAll(/^::group::/gmu)]).toHaveLength(
      [...diagnostics.matchAll(/^::endgroup::$/gmu)].length,
    );
    const pid = readFileSync(pidFile, "utf-8").trim();
    expect(pid).toMatch(/^[1-9]\d*$/u);
    const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", pid]);
    // Linux may retain an already-killed orphan briefly as a zombie.
    expect(new TextDecoder().decode(state.stdout).trim()).toMatch(/^Z.*$|^$/u);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

// timeout: The pool fixture has a 15 s watchdog; its deadline falls about
// 3 s after it starts.
test("the pool stops before its job's timeout and names the check still running", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-check-pool-deadline-"));
  const scripts = path.join(directory, "scripts");
  mkdirSync(scripts);
  mkdirSync(path.join(directory, ".github/ci-checks"), { recursive: true });
  mkdirSync(path.join(directory, ".github/workflows"), { recursive: true });
  for (const file of [
    "ci-check-pool.ts",
    "ci-check-pool-registry.ts",
    "github-expression.ts",
  ]) {
    copyFileSync(path.join(root, "scripts", file), path.join(scripts, file));
  }
  // The deadline is read from the job's own timeout-minutes.
  writeFileSync(
    path.join(directory, ".github/workflows/ci.yml"),
    Bun.YAML.stringify({
      jobs: {
        "ci-checks-rest": {
          "timeout-minutes": POOL_DEADLINE_MARGIN_MINUTES + 1,
          steps: [],
        },
      },
    }),
  );
  writeFileSync(
    path.join(directory, ".github/ci-checks/ci-checks-rest.yml"),
    Bun.YAML.stringify({
      checks: [
        {
          name: "Hung check",
          run: 'for i in $(seq 1 50); do echo "hung line $i"; done\nsleep 600',
        },
        { name: "Quick check", run: "echo quick" },
      ].map((entry) => ({ ...entry, if: "true", "timeout-minutes": 10 })),
    }),
  );
  writeFileSync(path.join(directory, "needs.json"), "{}");
  // The runner writes the event file as it sets up the job: this job started
  // 57 s ago, so one minute of its budget before the margin remains 3 s.
  const event = path.join(directory, "event.json");
  writeFileSync(event, "{}");
  const jobStart = (Date.now() - 57_000) / 1000;
  utimesSync(event, jobStart, jobStart);
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(scripts, "ci-check-pool.ts"),
      "run",
      "ci-checks-rest",
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env["PATH"] ?? "",
        RUNNER_TEMP: directory,
        GITHUB_JOB: "ci-checks-rest",
        GITHUB_EVENT_PATH: event,
        CI_CHECK_POOL_CONCURRENCY: "2",
        CI_CHECK_POOL_NEEDS_FILE: path.join(directory, "needs.json"),
        CI_CHECK_POOL_STEPS: "{}",
        CI_CHECK_POOL_INPUTS: "{}",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  try {
    const [output, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(1);
    expect(output).toMatch(
      /^Check pool deadline: \S+ \(job timeout-minutes 4 less 3\)$/mu,
    );
    expect(output).toMatch(/^Finished check: Quick check \(success, /mu);
    expect(output).toContain(
      "::error title=Check pool deadline::The check pool stopped 3 min before the timeout-minutes (4) of job ci-checks-rest in .github/workflows/ci.yml.",
    );
    expect(output).toMatch(
      /^FAILED check: Hung check -- still running after \d+\.\d s at the check pool deadline$/mu,
    );
    expect(output).toMatch(/^Still running: Hung check \(\d+\.\d s\)$/mu);
    expect(output).not.toContain("Still running: Quick check");
    expect(output).toMatch(
      /Interrupted check: Hung check \(running for \d+\.\d s\)/u,
    );
    // The last 40 lines of the hung check's output.
    expect(output).toMatch(/^\| hung line 50$/mu);
    expect(output).toMatch(/^\| hung line 11$/mu);
    expect(output).not.toMatch(/^\| hung line 10$/mu);
    expect(output).not.toContain("| Check | Result |");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);

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

test("every real pooled condition is decidable in both events", () => {
  // The pool decides `cancelled()` but no other status function, so a
  // condition such as `success()` would fail the pool step at run time.
  for (const job of CHECK_POOL_JOBS) {
    for (const pooled of readCheckPool(job)) {
      for (const event of ["pull_request", "merge_group"]) {
        expect(
          () => conditionHolds(pooled.condition, context(event, "")),
          `${job}: ${pooled.name}`,
        ).not.toThrow();
      }
    }
  }
});

test("every pooled expression reads only contexts the pool provides", () => {
  const roots = new Set<string>();
  const recording = {
    values: {},
    status: { cancelled: false },
    fallback: (reference: string) => {
      roots.add(reference.split(".")[0] ?? reference);
      return null;
    },
  };
  for (const job of CHECK_POOL_JOBS) {
    for (const pooled of readCheckPool(job)) {
      const expressions = [
        pooled.condition,
        ...Object.values(pooled.env).filter((value) => value.includes("${{")),
        ...(typeof pooled.continueOnError === "string"
          ? [pooled.continueOnError]
          : []),
      ];
      for (const expression of expressions) {
        roots.clear();
        evaluate(expression, recording);
        for (const read of roots) {
          expect(
            POOL_CONTEXT_ROOTS.some((known) => known === read),
            `${job}/${pooled.name} reads \`${read}\`, which the pool does not hand over`,
          ).toBe(true);
        }
      }
    }
  }
});

test("the generated manifest guard defers the scan engine outside PR depth runs and typecheck coverage to its job", () => {
  const guard = readCheckPool("ci-checks-rest").find(
    ({ name }) => name === "Generated files manifest guard",
  );
  expect(guard).toBeDefined();
  if (guard === undefined) {
    return;
  }
  const deferred = (inputs: Value, outputs: Record<string, string> = {}) => {
    const [planned] = planChecks(
      [guard],
      context(
        "merge_group",
        "",
        {},
        {
          inputs,
          outputs: { scan_engine_wasm_required: "true", ...outputs },
        },
      ),
    );
    expect(planned?.status).toBe("selected");
    return planned?.status === "selected"
      ? planned.env["GENERATED_CHECKS_IN_OTHER_JOBS"]
      : undefined;
  };
  expect(deferred({ pr_depth_only: true })).toBe('["",""]');
  expect(deferred({ pr_depth_only: false })).toBe('["scan-engine-wasm",""]');
  // Push and merge-group runs have no inputs: GitHub renders them as null.
  expect(deferred(null)).toBe('["scan-engine-wasm",""]');
  // code-quality-web-rest runs the full typecheck coverage in this run.
  expect(
    deferred(null, { package_checks_required: "true", trusted: "true" }),
  ).toBe('["scan-engine-wasm","api-typecheck-projects"]');
});

test("only a failed check's own error commands reach the job log", () => {
  const output = [
    "::error::Release history includes a fixture pull request",
    "::error file=a.ts,line=1::Expected refusal",
    "  ::error::already indented",
    "::warning::advisory note",
    "::group::scripts/a.test.ts:",
    "(pass) a [0.10ms]",
    "  ::endgroup::",
    "##[group]rendered",
    "##[endgroup]",
    "ok",
  ].join("\n");
  // The runner trims leading whitespace before it reads a command, so only a
  // removed command or a non-blank prefix is inert.
  const flat = ["scripts/a.test.ts:", "(pass) a [0.10ms]", "rendered", "ok"];
  const neutralized = [
    "| ::error::Release history includes a fixture pull request",
    "| ::error file=a.ts,line=1::Expected refusal",
    "|   ::error::already indented",
    "::warning::advisory note",
    ...flat,
  ].join("\n");
  for (const outcome of ["success", "skipped"] as const) {
    const text = checkLogText(output, outcome);
    expect(text).toBe(neutralized);
    for (const line of text.split("\n")) {
      expect(line.trimStart()).not.toMatch(
        /^(?:::(?:error|group|endgroup)\b|##\[)/u,
      );
    }
  }
  expect(checkLogText(output, "failure")).toBe(
    [
      "::error::Release history includes a fixture pull request",
      "::error file=a.ts,line=1::Expected refusal",
      "  ::error::already indented",
      "::warning::advisory note",
      ...flat,
    ].join("\n"),
  );
});
