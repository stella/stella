import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import {
  CHECK_BUDGETS,
  type CheckBudget,
  checkBudget,
} from "./ci-check-budgets";
import {
  blockingFailures,
  checkLogText,
  type CheckResult,
  conditionHolds,
  continueOnErrorHolds,
  failedCheckAnnotation,
  failureKind,
  isInfraTimeout,
  isNearBudget,
  type Launched,
  nearBudgetWarning,
  partitionChecks,
  planChecks,
  type PlannedCheck,
  POOL_CONTEXT_ROOTS,
  poolContext,
  processLauncher,
  reportedFailures,
  resolveEnv,
  runChecks,
  selectChecks,
  summaryTable,
  TIMED_OUT_CHECK_CLASS,
  timedOutCheckAnnotation,
  timedOutCheckCause,
  timeoutDetail,
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

const BUDGET: CheckBudget = { seconds: 60, p95Seconds: 10 };
const budgetOf = () => BUDGET;

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
  const pr = selected(
    planChecks(rest, context("pull_request", narrow), budgetOf),
  );
  expect(pr).toContain("Test oxlint plugins");
  expect(pr).not.toContain("Content delivery declarations");
  // A scoped check runs only when root_checks names it (or is empty).
  expect(pr).not.toContain("Workflow YAML");
  // Unscoped checks have no selection gate and always run.
  expect(pr).toContain("Queue authority");
  const queue = selected(
    planChecks(rest, context("merge_group", ""), budgetOf),
  );
  expect(queue).toContain("Content delivery declarations");
  expect(queue).not.toContain("Bridge-version guard");
  const reused = selected(
    planChecks(
      policy,
      context("push", "", {
        static_receipts: { outputs: { reuse_static_check_001: "true" } },
      }),
      budgetOf,
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
        budgetOf,
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
              budget: BUDGET,
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
              reportedFailures: [],
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
      BUDGET,
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
      BUDGET,
    );
    expect(failed.exitCode).not.toBe(0);
    expect(readFileSync(path.join(directory, "001.log"), "utf-8")).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    "ci-check-budgets.ts",
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
        ...Array.from({ length: 9 }, (_, index) => ({
          name: `Buffered log ${index}`,
          run: `printf '%s\\n' '${(index % 2 === 0 ? "\n" : "é🙂\n\n").repeat(20 * 1024)}'`,
        })),
        { name: "Later check", run: "sleep 600" },
      ].map((entry) => ({ ...entry, if: "true" })),
    }),
  );
  // Unmeasured: each fixture check gets the long default budget.
  writeFileSync(
    path.join(scripts, "ci-check-budgets.json"),
    JSON.stringify({
      ...JSON.parse(
        readFileSync(path.join(root, "scripts/ci-check-budgets.json"), "utf-8"),
      ),
      p95Seconds: {
        "ci-checks-policy": {},
        "ci-checks-rest": Object.fromEntries(
          [
            "Blocked first",
            "Buffered failure",
            ...Array.from({ length: 9 }, (_, index) => `Buffered log ${index}`),
            "Later check",
          ].map((name) => [name, null]),
        ),
        "code-quality-web-rest": {},
      },
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
    expect(output).toContain("Interrupted check: Blocked first (running)");
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
      timedOut: false,
      reportedFailures: [],
      detail: "exit code 1\nsee a|b \\ c",
      seconds: 1.25,
      budget: BUDGET,
      maxRssBytes: 2 * 1_048_576,
    },
    {
      name: "C",
      id: undefined,
      outcome: "skipped",
      continuedOnError: false,
      timedOut: false,
      reportedFailures: [],
      detail: "condition false",
      seconds: 0,
      budget: undefined,
      maxRssBytes: undefined,
    },
  ]).split("\n");
  expect(table).toHaveLength(4);
  expect(table[2]).toBe(
    String.raw`| A \| B | failure: exit code 1 see a\|b \\ c | 1.3 | 60 | 2 |`,
  );
  expect(table[3]).toBe("| C | skipped |  |  |  |");
});

test("continue-on-error lets a failed check pass the pool only when it holds", async () => {
  const queue = context("merge_group", "");
  const pr = context("pull_request", "");
  const lenient = EXPRESSION("github.event_name == 'merge_group'");
  const run = async (declared: PoolCheck["continueOnError"], at = queue) =>
    runChecks({
      planned: planChecks(
        [check("fails", { continueOnError: declared })],
        at,
        budgetOf,
      ),
      concurrency: 1,
      report: () => undefined,
      launch: async (): Promise<Launched> => ({
        exitCode: 1,
        timedOut: false,
        reportedFailures: [],
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
    planned: planChecks(
      [check("fails", { continueOnError: unknown })],
      queue,
      budgetOf,
    ),
    concurrency: 1,
    report: () => undefined,
    launch: async (): Promise<Launched> => ({
      exitCode: 1,
      timedOut: false,
      reportedFailures: [],
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
      budgetOf,
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

const workflowJobTimeoutMinutes = (job: string) => {
  const jobs =
    typeof workflow === "object" && workflow !== null && "jobs" in workflow
      ? workflow.jobs
      : undefined;
  const entry =
    typeof jobs === "object" && jobs !== null && job in jobs
      ? Reflect.get(jobs, job)
      : undefined;
  const minutes =
    typeof entry === "object" && entry !== null
      ? Reflect.get(entry, "timeout-minutes")
      : undefined;
  expect(typeof minutes, `${job} timeout-minutes`).toBe("number");
  return Number(minutes);
};
// The pool step starts after checkout, install and preparation.
const POOL_START_SECONDS = 300;
// A command that bounds itself (`timeout 30s cmd`) fails as an anonymous
// exit 124 before the pool's budget can report a typed timeout.
const SELF_TIMEOUT = /(?:^|[\s;&|(`])timeout\s+(?:-\S+\s+)*\d/mu;

test("every pooled check has one measured budget within its step and job deadlines", () => {
  for (const job of CHECK_POOL_JOBS) {
    const pooled = readCheckPool(job);
    // The ledger covers exactly the registry: no check falls back to a
    // default because it was forgotten, and a renamed one leaves no entry.
    expect(
      [...(CHECK_BUDGETS.p95Seconds.get(job)?.keys() ?? [])].toSorted(),
      job,
    ).toEqual(pooled.map(({ name }) => name).toSorted());
    const jobSeconds = workflowJobTimeoutMinutes(job) * 60;
    for (const entry of pooled) {
      const label = `${job}/${entry.name}`;
      const measured = checkBudget(job, entry.name, undefined);
      expect(measured.p95Seconds, label).not.toBeNull();
      // A step deadline below the measured budget would stop the check
      // first; the job deadline would cancel the pool before it reports.
      if (entry.timeoutMinutes !== undefined) {
        expect(entry.timeoutMinutes * 60, label).toBeGreaterThanOrEqual(
          measured.seconds,
        );
      }
      expect(measured.seconds + POOL_START_SECONDS, label).toBeLessThanOrEqual(
        jobSeconds,
      );
      expect(entry.run, label).not.toMatch(SELF_TIMEOUT);
    }
  }
  expect("timeout 30s bun test x").toMatch(SELF_TIMEOUT);
  expect("run || timeout -k 5 1m bun x").toMatch(SELF_TIMEOUT);
  expect("bun test --timeout 35000 x").not.toMatch(SELF_TIMEOUT);
});

test("a check past its budget is stopped and reported as a typed infrastructure timeout", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-check-pool-budget-"));
  try {
    const started = performance.now();
    const results = await runChecks({
      planned: planChecks(
        [check("Slow", { run: "sleep 30" }), check("Fails", { run: "exit 3" })],
        context("merge_group", ""),
        () => ({ seconds: 0.2, p95Seconds: 0.1 }),
      ),
      concurrency: 2,
      launch: processLauncher({ root, directory }),
      report: () => undefined,
    });
    expect(performance.now() - started).toBeLessThan(5000);
    const [slow, fails] = results;
    expect(slow).toMatchObject({ outcome: "failure", timedOut: true });
    expect(slow?.detail).toBe(
      timeoutDetail(slow?.seconds ?? 0, { seconds: 0.2, p95Seconds: 0.1 }),
    );
    expect(slow?.detail).toContain("(budget 0.2 s from p95 0.1 s)");
    expect(fails).toMatchObject({
      outcome: "failure",
      timedOut: false,
      reportedFailures: [],
      detail: "exit code 3",
    });
    // Only timeouts: automation may rerun. Any finding: a red result.
    expect(failureKind(results.slice(0, 1))).toBe("infra");
    expect(failureKind(results)).toBe("finding");
    expect(failureKind([])).toBe("none");
    expect(summaryTable(results).split("\n")[2]).toStartWith(
      "| Slow | timeout (infra): timed out after ",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a timeout names its check, how long it ran and its budget", () => {
  const cause = timedOutCheckCause(91.04, { seconds: 91, p95Seconds: 30.1 });
  expect(cause).toBe(
    `${TIMED_OUT_CHECK_CLASS} elapsed_s=91.0 budget_s=91 p95_s=30.1`,
  );
  expect(timedOutCheckCause(600, { seconds: 600, p95Seconds: null })).toEndWith(
    "p95_s=unmeasured",
  );
  expect(
    timedOutCheckAnnotation(
      { name: "Check Docker source closure", detail: "timed out" },
      cause,
    ),
  ).toBe(
    `::error title=TIMED OUT check%3A Check Docker source closure::${cause}: timed out`,
  );
});

test("a check that passes after most of its budget is a warning, not a failure", () => {
  const budget = { seconds: 100, p95Seconds: 30 };
  const passed = (seconds: number): CheckResult => ({
    name: "Near",
    id: undefined,
    outcome: "success",
    continuedOnError: false,
    timedOut: false,
    reportedFailures: [],
    detail: "passed",
    seconds,
    budget,
    maxRssBytes: undefined,
  });
  const threshold = budget.seconds * CHECK_BUDGETS.warnFraction;
  expect(isNearBudget(passed(threshold - 0.1))).toBe(false);
  expect(isNearBudget(passed(threshold))).toBe(true);
  expect(blockingFailures([passed(99)])).toEqual([]);
  expect(summaryTable([passed(99)]).split("\n")[2]).toBe(
    "| Near | success (near budget) | 99.0 | 100 |  |",
  );
  expect(nearBudgetWarning(passed(99), budget)).toStartWith(
    "::warning title=Check near its budget%3A Near::passed after 99.0 s, 99%25 of its budget 100 s from p95 30 s",
  );
});

test("a selected check without a budget is invalid, never unbounded", () => {
  const [planned] = planChecks(
    [check("Unknown")],
    context("merge_group", ""),
    (entry) => checkBudget("ci-checks-rest", entry.name, undefined),
  );
  expect(planned?.status).toBe("invalid");
  expect(planned?.status === "invalid" ? planned.message : "").toContain(
    'ci-checks-rest: "Unknown" has no entry in scripts/ci-check-budgets.json',
  );
});

test("a check that failed before it timed out is a finding, never infra", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-check-pool-teardown-"));
  try {
    // A test fails, then teardown hangs until the budget stops it.
    const run = [
      "echo '(pass) parser > accepts input [0.10ms]'",
      "echo 'error: expect(received).toBe(expected)'",
      "echo '(fail) parser > rejects input [0.20ms]'",
      "sleep 30",
    ].join("\n");
    const results = await runChecks({
      planned: planChecks(
        [
          check("Teardown hang", { run }),
          check("Plain hang", { run: "sleep 30" }),
        ],
        context("merge_group", ""),
        () => ({ seconds: 0.5, p95Seconds: 0.1 }),
      ),
      concurrency: 2,
      launch: processLauncher({ root, directory }),
      report: () => undefined,
    });
    const [teardown, plain] = results;
    expect(teardown).toMatchObject({
      outcome: "failure",
      timedOut: true,
      reportedFailures: ["(fail) parser > rejects input [0.20ms]"],
    });
    expect(plain).toMatchObject({ timedOut: true, reportedFailures: [] });
    expect(plain !== undefined && isInfraTimeout(plain)).toBe(true);
    expect(teardown !== undefined && isInfraTimeout(teardown)).toBe(false);
    expect(failureKind(results.slice(0, 1))).toBe("finding");
    expect(failureKind(results.slice(1))).toBe("infra");
    expect(failureKind(results)).toBe("finding");
    expect(summaryTable(results).split("\n")[2]).toStartWith(
      "| Teardown hang | failure, then timeout: timed out after ",
    );
    // Its annotation names the assertion, not the timeout.
    expect(
      failedCheckAnnotation(
        teardown ?? { name: "", detail: "" },
        readFileSync(path.join(directory, "000.log"), "utf-8"),
      ),
    ).toBe(
      "::error title=FAILED check%3A Teardown hang::(fail) parser > rejects input [0.20ms] -- error: expect(received).toBe(expected)",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reported failures are failed tests and error commands only", () => {
  expect(
    reportedFailures(
      [
        "(pass) a [1ms]",
        "  (fail) b [2ms]",
        "::error file=a.ts::boom",
        "##[error]rendered",
        "error: plain text is not an annotation",
        "::warning::advisory",
      ].join("\n"),
    ),
  ).toEqual(["(fail) b [2ms]", "::error file=a.ts::boom", "##[error]rendered"]);
});
