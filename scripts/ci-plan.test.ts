import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import nodePath from "node:path";
import { Script } from "node:vm";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { repoRelativePath } from "@stll/portable-path";
import { assertProperty, drawPropertySamples } from "@stll/property-testing";

import eventPolicies from "../.github/ci-event-policy.json" with { type: "json" };
import {
  POSTGRES_SHARD_TEST_BUDGET_SECONDS,
  POSTGRES_TEST_SHARD_IDS,
} from "../apps/api/scripts/postgres-test-shards";
import queuedJob from "./__fixtures__/ci-cancellation/queued-job.json" with { type: "json" };
import supersessionAnnotations from "./__fixtures__/ci-cancellation/supersession.json" with { type: "json" };
import timeoutAnnotations from "./__fixtures__/ci-cancellation/timeout.json" with { type: "json" };
import { selectApiTestImpact } from "./api-test-impact";
import { FULL_TEST_JOB_SHARDS } from "./api-test-shard-plan";
import { readSelectionGraph } from "./ci-affected-selection";
import { planCiApiTests } from "./ci-api-test-plan";
import {
  CANONICAL_CANCEL_STEP,
  PR_CODE_QUALITY_CANCEL_IF,
  PR_CODE_QUALITY_CANCEL_JOBS,
  PR_CODE_QUALITY_CANCEL_STEP,
  PR_CODE_QUALITY_JOBS,
} from "./ci-cancellation-contract";
import { markdownReaders, requiresPackageChecks } from "./ci-package-scope";
import {
  computeChangedFileScope,
  DEFAULT_DETECTORS,
  OUTPUT_ORDER,
  type ScopeOutput,
} from "./ci-plan-scope";
import { prHeavyJobs } from "./ci-pr-jobs";
import { pilotFastJobs } from "./ci-pr-pilot-plan";
import {
  embedsExpression,
  GITHUB_EXPRESSION_LIMIT,
  renderResultInputs,
  RESULT_INPUTS_RUN,
  RESULT_INPUTS_STEP,
} from "./ci-result-inputs";
import { selectRootChecks } from "./ci-root-checks";
import { withoutStaticReuseCondition } from "./ci-static-checks.test-support";
import { E2E_SHARD_COUNT } from "./e2e-spec-shards-core";
import { GENERATORS } from "./generated-files";
import {
  type Context,
  contextWithPlanOutputs,
  evaluate as evaluateExpression,
  UNKNOWN,
} from "./github-expression";
import {
  ARMED_LABEL,
  HEAVY_PROOF_GATE,
  heavyProofJobs,
  mainHeavyJobs,
  MERGE_GROUP_EXCEPTIONS,
  MERGE_GROUP_HEAVY_KEEP,
  prDepthJobs,
  queueAdmittedJobs,
  thinJobs,
} from "./main-heavy-plan";
import { unlistedTests } from "./run-unlisted-script-tests";
import { TEST_JOB_SHARDS, type TestShardId } from "./test-shards";
import { flattenWorkflowSteps } from "./workflow-steps";

// Ordinary events never run the main PR-depth caller and reuse nothing unless
// a case says so; cases that exercise either set the value explicitly.
const ORDINARY_EVENT_VALUES = {
  "github.event.action": "synchronize",
  "inputs.pr_depth_only": false,
  "needs.ci-plan.outputs.pr_depth_reused": "false",
};
const evaluate = (source: string, context: Context) =>
  evaluateExpression(source, {
    ...context,
    values: { ...ORDINARY_EVENT_VALUES, ...context.values },
  });

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
// The immutable repository census is shared fixture setup. Property budgets
// measure selector cases rather than charging its cold scan to the first case.
markdownReaders();

type BashCase = {
  flags: readonly string[];
  script: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
};

type BashOutcome = { exitCode: number; stdout: string; stderr: string };

// Reads each case as NUL-separated fields: flag count, flags, script, env
// count, KEY=VALUE pairs, argument count, arguments. Every case runs in its
// own bash process, exactly as a separate spawn would, with the driver's
// PATH-only environment plus the case's variables. The test pays one spawn
// per batch rather than one per property sample, and up to `jobs` cases run
// at once.
const BASH_BATCH_DRIVER = `directory=$1
count=$2
jobs=$3
run_case() {
  local index=$1 field position size script
  local fields=() flags=() variables=() arguments=()
  while IFS= read -r -d '' field; do fields+=("$field"); done < "$directory/$index.in"
  position=0
  size=\${fields[position]}
  flags=("\${fields[@]:position+1:size}")
  position=$((position + 1 + size))
  script=\${fields[position]}
  position=$((position + 1))
  size=\${fields[position]}
  variables=("\${fields[@]:position+1:size}")
  position=$((position + 1 + size))
  size=\${fields[position]}
  arguments=("\${fields[@]:position+1:size}")
  (
    if ((\${#variables[@]} > 0)); then export "\${variables[@]}"; fi
    exec "$BASH" "\${flags[@]}" -c "$script" ci-plan-test "\${arguments[@]}"
  ) > "$directory/$index.out" 2> "$directory/$index.err"
  printf '%s' "$?" > "$directory/$index.status"
}
for ((index = 0; index < count; index++)); do
  run_case "$index" &
  if (((index + 1) % jobs == 0)); then
    wait
  fi
done
wait`;

// Cases are independent processes; a small pool keeps a batch well inside a
// test's budget without crowding a shared runner.
const BASH_BATCH_JOBS = Math.min(4, availableParallelism());

const runBashBatch = <T>(
  items: readonly T[],
  toCase: (item: T) => BashCase,
): (BashOutcome & { item: T })[] => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-plan-batch-"));
  try {
    for (const [index, item] of items.entries()) {
      const { flags, script, args, env } = toCase(item);
      const variables = Object.entries(env).map(
        ([name, value]) => `${name}=${value}`,
      );
      const fields = [
        String(flags.length),
        ...flags,
        script,
        String(variables.length),
        ...variables,
        String(args.length),
        ...args,
      ];
      if (fields.some((field) => field.includes("\0"))) {
        throw new TypeError(`A bash case field contains NUL: ${script}`);
      }
      writeFileSync(
        nodePath.join(directory, `${index}.in`),
        fields.map((field) => `${field}\0`).join(""),
      );
    }
    const driver = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        BASH_BATCH_DRIVER,
        "ci-plan-batch",
        directory,
        String(items.length),
        String(BASH_BATCH_JOBS),
      ],
      env: { PATH: Bun.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(driver.exitCode, driver.stderr.toString()).toBe(0);
    return items.map((item, index) => {
      const read = (extension: string) =>
        readFileSync(
          nodePath.join(directory, `${index}.${extension}`),
          "utf-8",
        );
      return {
        item,
        exitCode: Number(read("status")),
        stdout: read("out"),
        stderr: read("err"),
      };
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const onlyOutcome = <T>(outcomes: readonly T[]): T => {
  const [outcome, ...rest] = outcomes;
  if (outcome === undefined || rest.length > 0) {
    throw new TypeError(`Expected one outcome, received ${outcomes.length}`);
  }
  return outcome;
};

const isScopeOutput = (output: string): output is ScopeOutput =>
  OUTPUT_ORDER.some((candidate) => candidate === output);

type SelectorCase = {
  files: readonly string[];
  // Job-level ci-plan outputs derived in ci.yml from path scopes are not path
  // scopes themselves: they read as unset here.
  outputs: readonly string[];
  suiteDepth?: string;
  e2eLandingRequired?: string;
  event?: string;
  title?: string;
  armed?: boolean;
};

const planSelector = <C extends SelectorCase>(cases: readonly C[]) =>
  cases.map((item) => {
    const scope = computeChangedFileScope(
      {
        changedFiles: item.files,
        comparisonBase: "",
        scopeUnknown: false,
        eventName: item.event ?? "pull_request",
        suiteDepth: item.suiteDepth ?? "fast",
        heavyOnly: false,
        prTitle: item.title ?? "",
        armed: item.armed ?? false,
      },
      {
        ...DEFAULT_DETECTORS,
        // The landing deploy scope reads git; the case pins its answer.
        landingDeploy: () => item.e2eLandingRequired === "true",
      },
    );
    return {
      item,
      plan: item.outputs.map((output) =>
        isScopeOutput(output) ? scope[output] : "",
      ),
    };
  });

const runSelector = (
  files: readonly string[],
  outputs: readonly string[],
  suiteDepth = "fast",
  e2eLandingRequired = "false",
  event = "pull_request",
  title = "",
) =>
  onlyOutcome(
    planSelector([
      { files, outputs, suiteDepth, e2eLandingRequired, event, title },
    ]),
  ).plan;

const releaseExtraFiles = fc.array(fc.string(), { maxLength: 8 });

const unrelatedDocNames = fc.array(fc.uuid(), { maxLength: 8 });

const MatrixEntry = v.object({ runner: v.string(), platform: v.string() });

const apiSourceSiblings = fc.array(fc.uuid(), { maxLength: 4 });

// Property samples are drawn up front and evaluated as one batch, since each
// evaluation runs bash. Each sample's label carries its replay seed and index.

const workflowJobs = (source: string) =>
  v.parse(
    v.object({ jobs: v.record(v.string(), v.unknown()) }),
    Bun.YAML.parse(source),
  ).jobs;

const jobIf = (job: unknown) =>
  v.parse(v.object({ if: v.optional(v.string()) }), job).if ?? "";

const ciJobs = workflowJobs(workflow);

test("migration coverage uses the pinned CI comparison base", () => {
  const job = v.parse(
    v.object({
      steps: v.array(
        v.looseObject({
          name: v.optional(v.string()),
          env: v.optional(v.record(v.string(), v.string())),
        }),
      ),
    }),
    ciJobs["database-migrations-check"],
  );
  const coverage = job.steps.find(
    ({ name }) => name === "Check migration coverage",
  );
  expect(coverage?.env?.["BASE_REF"]).toBe(
    ["$", "{{ needs.ci-plan.outputs.target_base_sha || 'HEAD^' }}"].join(""),
  );
});

test("migration check jobs disable production load gates", () => {
  const migrationStepNames = new Set([
    "Test migration safety rules and historical findings",
    "Apply all migrations to fresh Postgres",
  ]);
  const migrationJobs = Object.entries(ciJobs).filter(([, job]) => {
    const { steps } = v.parse(
      v.looseObject({
        steps: v.optional(
          v.array(v.looseObject({ name: v.optional(v.string()) })),
        ),
      }),
      job,
    );
    return steps?.some(({ name }) => name && migrationStepNames.has(name));
  });

  expect(migrationJobs.map(([id]) => id).toSorted()).toEqual([
    "database-migrations-apply-fresh",
    "database-migrations-check",
  ]);
  for (const [id, job] of migrationJobs) {
    const { env } = v.parse(
      v.looseObject({ env: v.record(v.string(), v.string()) }),
      job,
    );
    expect(env["DB_LOAD_GATE_EBS_SIGNAL"], id).toBe("disabled");
    expect(env["DB_LOAD_GATE_BUSY_WINDOWS"], id).toBe("[]");
  }
});

test("required checks report on pull requests and merge groups", () => {
  const required = [
    ["ci-result", workflow, "ci-result"],
    ["dependency-review", workflow, "dependency-review"],
    [
      "cla",
      readFileSync(
        new URL("../.github/workflows/cla.yml", import.meta.url),
        "utf-8",
      ),
      "verify-signatures",
    ],
  ] as const;
  for (const [check, source, job] of required) {
    const parsed = v.parse(
      v.looseObject({
        on: v.record(v.string(), v.unknown()),
        jobs: v.record(v.string(), v.unknown()),
      }),
      Bun.YAML.parse(source),
    );
    expect(parsed.jobs, check).toHaveProperty(job);
    expect(parsed.on, check).toHaveProperty("merge_group");
    expect(parsed.on, check).toHaveProperty(
      check === "cla" ? "pull_request_target" : "pull_request",
    );
  }
  expect(required.at(2)?.[1]).toContain('name = "cla"');
});

// The planner and tests share the dependency-closure owner.
const PR_HEAVY_JOBS = prHeavyJobs({ jobs: ciJobs });
const releaseJobs = workflowJobs(
  readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf-8",
  ),
);
// Every check waits for the plan, so it stays install-light: one planner
// install, and generation runs in its own job for its consumers only.
test("the plan installs dependencies once and never generates sources", () => {
  const steps = v.parse(
    v.object({
      steps: v.array(
        v.looseObject({
          name: v.optional(v.string()),
          uses: v.optional(v.string()),
          run: v.optional(v.string()),
        }),
      ),
    }),
    ciJobs["ci-plan"],
  ).steps;
  const installs = steps.filter(
    ({ uses, run }) =>
      uses === "$/.github/actions/ci-install" ||
      /\bbun (?:ci|install)\b/u.test(run ?? ""),
  );
  expect(installs.map(({ name }) => name)).toEqual([
    "Install planner dependencies",
  ]);
  expect(
    steps.filter(({ run }) => run?.includes("ci-generated-sources.ts")),
  ).toEqual([]);
});

// An undeclared output becomes an empty string, overriding even an environment
// value established by an earlier step.
test("CI planner output references name declared outputs", () => {
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  const declared = new Set(Object.keys(plan.outputs));
  const references = new Set(
    [
      ...JSON.stringify(ciJobs).matchAll(/needs\.ci-plan\.outputs\.([\w-]+)/gu),
    ].flatMap(([, output]) => (output === undefined ? [] : [output])),
  );
  expect(references.size).toBeGreaterThan(0);
  expect(
    [...references].filter((output) => !declared.has(output)).toSorted(),
  ).toEqual([]);
});

const resultJob = v.parse(
  v.object({
    needs: v.array(v.string()),
    steps: v.array(v.unknown()),
  }),
  ciJobs["ci-result"],
);

const CANCEL_REUSABLE_JOB = "marketing-screenshots-cancel";
const MAIN_ONLY_JOBS = new Set(["api-test-durations"]);
const CANCELLATION_EXCEPTIONS = new Set([
  // These moved jobs retain the exact least-privilege grants from their
  // standalone workflows, so neither can cancel a merge-group run.
  "dependency-audit",
  "dependency-review",
  // Runs only for pull requests, so it never has a merge group to cancel.
  "pr-heavy-gate",
  "query-perf",
  "fix-tests-on-base",
  "heavy-web-build",
  "marketing-screenshots",
  CANCEL_REUSABLE_JOB,
  ...Object.keys(PR_CODE_QUALITY_CANCEL_JOBS),
  ...MAIN_ONLY_JOBS,
]);
const cancellationJobSchema = v.looseObject({
  if: v.optional(v.string()),
  permissions: v.optional(v.record(v.string(), v.string())),
  steps: v.optional(
    v.array(
      v.looseObject({
        name: v.optional(v.string()),
        if: v.optional(v.string()),
        uses: v.optional(v.string()),
        run: v.optional(v.string()),
        shell: v.optional(v.string()),
        env: v.optional(v.record(v.string(), v.string())),
        with: v.optional(v.record(v.string(), v.unknown())),
      }),
    ),
  ),
});
const regularCancellationJobs = () =>
  Object.entries(ciJobs).filter(([id]) => !CANCELLATION_EXCEPTIONS.has(id));

test("only dedicated helpers end a failed code quality pull request run", () => {
  const helpers = Object.entries(PR_CODE_QUALITY_CANCEL_JOBS);
  for (const [id, dependency] of helpers) {
    const helper = v.parse(
      v.looseObject({
        needs: v.string(),
        if: v.string(),
        "timeout-minutes": v.number(),
        permissions: v.record(v.string(), v.string()),
        steps: v.array(v.unknown()),
      }),
      ciJobs[id],
    );
    expect(helper.needs, id).toBe(dependency);
    expect(helper.if, id).toBe(PR_CODE_QUALITY_CANCEL_IF);
    expect(helper["timeout-minutes"], id).toBe(1);
    expect(helper.permissions, id).toEqual({ actions: "write" });
    expect(helper.steps, id).toEqual([PR_CODE_QUALITY_CANCEL_STEP]);
  }
  for (const id of PR_CODE_QUALITY_JOBS) {
    const steps = v.parse(cancellationJobSchema, ciJobs[id]).steps ?? [];
    expect(
      steps.some(({ name }) => name === PR_CODE_QUALITY_CANCEL_STEP.name),
      id,
    ).toBe(false);
    expect(steps.at(-1)?.name, id).toBe(CANONICAL_CANCEL_STEP.name);
  }
  expect(helpers.map(([id]) => id).toSorted()).toEqual(
    Object.keys(PR_CODE_QUALITY_CANCEL_JOBS).toSorted(),
  );
  expect(PR_CODE_QUALITY_CANCEL_STEP.with.script).not.toContain("merge group");
  expect(
    new Set(
      helpers.map(
        ([id]) =>
          v.parse(cancellationJobSchema, ciJobs[id]).steps?.at(0)?.with?.[
            "script"
          ],
      ),
    ).size,
  ).toBe(1);
});

test("every eligible CI job cancels a failed merge group in its final step with job-scoped permission", () => {
  expect(ciJobs["merge-group-fail-fast"]).toBeUndefined();
  for (const id of CANCELLATION_EXCEPTIONS) {
    expect(ciJobs[id], id).toBeDefined();
  }
  const eligible = new Set(regularCancellationJobs().map(([id]) => id));
  expect(eligible.size).toBeGreaterThan(0);
  for (const [id, value] of Object.entries(ciJobs)) {
    const body = v.parse(cancellationJobSchema, value);
    expect(body.permissions?.["actions"] === "write", id).toBe(
      eligible.has(id) ||
        id === CANCEL_REUSABLE_JOB ||
        Object.hasOwn(PR_CODE_QUALITY_CANCEL_JOBS, id) ||
        MAIN_ONLY_JOBS.has(id),
    );
    const cancellations =
      body.steps?.filter(({ name }) => name === CANONICAL_CANCEL_STEP.name) ??
      [];
    expect(cancellations.length, id).toBe(
      Number(
        eligible.has(id) ||
          id === CANCEL_REUSABLE_JOB ||
          id === "pr-heavy-gate",
      ),
    );
    if (!eligible.has(id)) {
      continue;
    }
    const tail = body.steps?.at(-1);
    expect(tail, id).toEqual({
      ...CANONICAL_CANCEL_STEP,
      if: "failure() && github.event_name == 'merge_group'",
    });
  }
  const permissions = v.parse(
    v.object({ permissions: v.record(v.string(), v.string()) }),
    Bun.YAML.parse(workflow),
  ).permissions;
  expect(permissions["actions"]).not.toBe("write");
  const tests = v.parse(
    v.looseObject({ strategy: v.object({ "fail-fast": v.boolean() }) }),
    ciJobs["ci-tests"],
  );
  expect(tests.strategy["fail-fast"]).toBe(false);
  expect(jobIf(ciJobs["fix-tests-on-base"])).toContain(
    "github.event_name == 'pull_request'",
  );
  expect(jobIf(ciJobs["route-smoke"])).toContain(HEAVY_PROOF_GATE);
  expect(jobIf(ciJobs["heavy-web-build"])).toContain(
    "needs.ci-plan.outputs.heavy_web_build_required == 'true'",
  );
  expect(resultJob.needs).not.toContain(CANCEL_REUSABLE_JOB);
  for (const id of [
    "route-smoke",
    "e2e-production-shard",
    "marketing-screenshots",
  ]) {
    expect(jobIf(ciJobs[id]), id).toContain(
      "(github.event_name != 'merge_group' || !cancelled())",
    );
  }
});

test("all failure tails and screenshot cancellation use the canonical same-run API step", async () => {
  const helper = v.parse(
    v.looseObject({
      needs: v.string(),
      if: v.string(),
      "timeout-minutes": v.number(),
      permissions: v.record(v.string(), v.string()),
      steps: v.array(v.unknown()),
    }),
    ciJobs[CANCEL_REUSABLE_JOB],
  );
  expect(helper.needs).toBe("marketing-screenshots");
  expect(helper.if).toBe("failure() && github.event_name == 'merge_group'");
  expect(helper["timeout-minutes"]).toBe(1);
  expect(helper.permissions).toEqual({ actions: "write" });
  expect(helper.steps).toEqual([CANONICAL_CANCEL_STEP]);
  const cancel = CANONICAL_CANCEL_STEP;
  for (const event of [
    "pull_request",
    "push",
    "workflow_dispatch",
    "merge_group",
  ]) {
    for (const failed of [false, true]) {
      const calls: unknown[] = [];
      const enabled: unknown = new Script(
        `Boolean(${helper.if})`,
      ).runInNewContext({
        failure: () => failed,
        github: { event_name: event },
      });
      if (enabled) {
        await new Script(
          `(async () => { ${cancel.with.script} })()`,
        ).runInNewContext({
          context: {
            repo: { owner: "fixture-owner", repo: "fixture-repository" },
            runId: 424_242,
          },
          process: { env: { GITHUB_RUN_ATTEMPT: "1" } },
          setTimeout,
          clearTimeout,
          core: {
            error: () => {},
            summary: { addRaw: () => {}, write: async () => {} },
          },
          github: {
            paginate: async () => [],
            rest: {
              actions: {
                cancelWorkflowRun: async (arguments_: unknown) => {
                  calls.push(arguments_);
                },
              },
            },
          },
        });
      }
      expect(calls, `${event}/${failed}`).toEqual(
        event === "merge_group" && failed
          ? [
              {
                owner: "fixture-owner",
                repo: "fixture-repository",
                run_id: 424_242,
              },
            ]
          : [],
      );
    }
  }
});

const evaluationSteps = resultJob.steps.filter((step) =>
  v.is(v.object({ name: v.literal("Evaluate CI outcome") }), step),
);
if (evaluationSteps.length !== 1) {
  throw new TypeError("CI result must have exactly one evaluation step");
}
const resultStep = v.parse(
  v.object({
    run: v.string(),
    env: v.record(v.string(), v.string()),
  }),
  evaluationSteps.at(0),
);
const resultInputsSteps = resultJob.steps.filter((step) =>
  v.is(v.object({ name: v.literal(RESULT_INPUTS_STEP) }), step),
);
const resultInputsStepIndex = resultJob.steps.findIndex((step) =>
  v.is(v.object({ name: v.literal(RESULT_INPUTS_STEP) }), step),
);

const jobScopes = v.parse(
  v.record(v.string(), v.nullable(v.string())),
  JSON.parse(resultStep.env["JOB_SCOPES"] ?? ""),
);

/**
 * What a gated job reads besides its scope once ci-plan and the generated
 * sources succeeded: a pull request's gate passed, and any other event
 * skipped it.
 */
const heavyGateContext = (event: string) => ({
  values: {
    "github.event_name": event,
    "needs.ci-plan.result": "success",
    "needs.ci-plan.outputs.run_required": "true",
    "needs.ci-plan.outputs.heavy_proof": "true",
    "needs.ci-plan.outputs.armed_delta": "false",
    "needs.generated-sources.result": "success",
    "needs.pr-heavy-gate.result":
      event === EVENT.pullRequest ? "success" : "skipped",
  },
  status: { cancelled: false },
});

// Scopes ci-plan computes in its outputs rather than in the path selector.
const COMPUTED_SCOPES: ReadonlySet<string> = new Set([
  "ci_browser_required",
  "pr_heavy_gate_required",
]);

const fastJobScopes = v.parse(
  v.record(v.string(), v.string()),
  JSON.parse(resultStep.env["FAST_JOB_SCOPES"] ?? ""),
);

const foldedSuites = v.parse(
  v.record(v.string(), v.record(v.string(), v.string())),
  JSON.parse(resultStep.env["FOLDED_SUITES"] ?? ""),
);

const EVENT = {
  mergeGroup: "merge_group",
  pullRequest: "pull_request",
  workflowDispatch: "workflow_dispatch",
} as const;
type Event = (typeof EVENT)[keyof typeof EVENT];

const SUITE_DEPTH = { fast: "fast", full: "full" } as const;
type SuiteDepth = (typeof SUITE_DEPTH)[keyof typeof SUITE_DEPTH];

const FULL_DEPTH_EVENTS = [EVENT.mergeGroup, EVENT.workflowDispatch] as const;

type EvaluateResultOptions = {
  event: Event | "push";
  results: Record<string, string>;
  suiteDepth?: SuiteDepth | "";
  unplannedScopes?: readonly string[];
  plannedOutputs?: Record<string, string>;
  trusted?: "true" | "false";
  /** The pull request's draft state as the API reports it now; unset fails the lookup. */
  liveDraft?: boolean;
  suiteResults?: Record<string, string>;
  cancellationEvidence?:
    "superseded" | "timeout" | "step-timeout" | "missing" | "wrong-group";
  apiFailure?: "current-run" | "runs" | "jobs" | "annotations";
  newerRun?:
    | "same-group"
    | "none"
    | "other-ref"
    | "other-pr"
    | "other-workflow"
    | "other-event"
    | "older"
    | "same-time";
  queuedCancellation?: "with-check" | "without-check";
  missingJob?: boolean;
  matrixTimeoutSibling?: boolean;
  embeddedStepFailure?: boolean;
  jobConclusion?: "cancelled" | "failure" | "timed_out";
  heavyOnly?: boolean;
  outcomeScript?: string;
  metadataCodeRun?:
    | "green"
    | "red"
    | "missing"
    | "other-head"
    | "running-green"
    | "queued-green"
    | "planned-green"
    | "completed-without-result"
    | "running";
};

const mainHeavyJobNames = mainHeavyJobs({ jobs: ciJobs });

const PULL_REQUEST = { repo: "stella/stella", number: "7" } as const;

type MetadataCodeRun = NonNullable<EvaluateResultOptions["metadataCodeRun"]>;

// GitHub lists a job only once it is queued: a queued run shows no jobs, a
// running one its ci-plan before its ci-result.
type CodeRunStage = "queued" | "planned" | "in_progress" | "completed";

const firstCodeRunStage: Partial<Record<MetadataCodeRun, CodeRunStage>> = {
  "running-green": "in_progress",
  "queued-green": "queued",
  "planned-green": "planned",
};

const metadataCodeRunFixtures = (state: MetadataCodeRun | undefined) => {
  const head = state === "other-head" ? "b".repeat(40) : "a".repeat(40);
  const runStatus =
    state === "running" || (state !== undefined && state in firstCodeRunStage)
      ? "in_progress"
      : "completed";
  const runs =
    state === "missing"
      ? []
      : [
          {
            // Older than the mirroring run (123): a mirror never waits on a newer one.
            id: 100,
            run_number: 99,
            head_sha: head,
            status: runStatus,
            pull_requests: [{ number: Number(PULL_REQUEST.number) }],
          },
        ];
  const conclusion = state === "red" ? "failure" : "success";
  const plan = {
    id: 1,
    name: "ci-plan",
    status: "completed",
    conclusion: "success",
  };
  const listed: Record<CodeRunStage, unknown[]> = {
    queued: [],
    planned: [plan],
    in_progress: [
      plan,
      {
        id: 2,
        name: "ci-result",
        status: "in_progress",
        conclusion: null,
        run_attempt: 1,
      },
    ],
    completed: [
      plan,
      {
        id: 2,
        name: "ci-result",
        status: "completed",
        conclusion,
        run_attempt: 1,
      },
    ],
  };
  const jobs = (stage: CodeRunStage) => [{ jobs: listed[stage] }];
  const finalStages: Partial<Record<MetadataCodeRun, CodeRunStage>> = {
    running: "in_progress",
    "completed-without-result": "planned",
  };
  const finalStage =
    (state === undefined ? undefined : finalStages[state]) ?? "completed";
  return {
    enabled: state === undefined ? "false" : "true",
    runRequired: state === undefined ? "true" : "false",
    firstJobs: jobs(
      (state === undefined ? undefined : firstCodeRunStage[state]) ??
        finalStage,
    ),
    finalJobs: jobs(finalStage),
    // The required-jobs record the code run uploaded: the mirror's evidence.
    record: {
      version: 1,
      event: "pull_request",
      head_sha: head,
      run_id: 100,
      run_attempt: 1,
      basis: "evaluated",
      pass_through_reason: null,
      reused_from_run_id: null,
      required: [{ job: "ci-tests", conclusion }],
      verdict: conclusion,
    },
    runs,
    state: state ?? "",
  };
};

// Fake only the GitHub endpoints the extracted evaluator actually calls.
const fakeGhDirectory = mkdtempSync(nodePath.join(tmpdir(), "ci-result-gh-"));
writeFileSync(
  nodePath.join(fakeGhDirectory, "gh"),
  `#!/usr/bin/env bash
set -eu
if [[ "$1" == "run" && "$2" == "download" && "$3" == "100" ]]; then
  while (($#)) && [[ "$1" != "-D" ]]; do shift; done
  printf '%s\n' "$FAKE_CODE_RECORD" > "$2/ci-required-summary.json"
  exit 0
fi
[[ "$1" == "api" ]] || exit 2
shift
while [[ "$1" == "--paginate" || "$1" == "--slurp" ]]; do shift; done
endpoint="$1"
case "$endpoint" in
  "repos/${PULL_REQUEST.repo}/pulls/${PULL_REQUEST.number}")
    [[ -n "\${FAKE_LIVE_DRAFT:-}" ]] || exit 1
    echo "$FAKE_LIVE_DRAFT"
    ;;
  "repos/${PULL_REQUEST.repo}/actions/runs/123")
    [[ "$FAKE_API_FAILURE" != "current-run" ]] || exit 1
    echo "$FAKE_CURRENT_RUN"
    ;;
  "repos/${PULL_REQUEST.repo}/actions/workflows/42/runs?event="*)
    [[ "$FAKE_API_FAILURE" != "runs" ]] || exit 1
    echo "$FAKE_RUNS"
    ;;
  "repos/${PULL_REQUEST.repo}/actions/runs/123/attempts/1/jobs?per_page=100")
    [[ "$FAKE_API_FAILURE" != "jobs" ]] || exit 1
    echo "$FAKE_JOBS"
    ;;
  "repos/${PULL_REQUEST.repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha="*)
    echo "$FAKE_CODE_RUNS"
    ;;
  "repos/${PULL_REQUEST.repo}/actions/runs/124/jobs?per_page=100")
    # The newer run that superseded this one is a code run.
    echo '[{"jobs":[{"name":"ci-plan"}]}]'
    ;;
  "repos/${PULL_REQUEST.repo}/actions/runs/100/jobs?per_page=100")
    state="${nodePath.join(fakeGhDirectory, "metadata-counter")}-$FAKE_CODE_STATE"
    if [[ ! -e "$state" ]]; then
      : > "$state"
      echo "$FAKE_CODE_JOBS_FIRST"
    else
      echo "$FAKE_CODE_JOBS"
    fi
    ;;
  https://api.github.com/repos/${PULL_REQUEST.repo}/check-runs/*/annotations?per_page=100)
    [[ "$FAKE_API_FAILURE" != "annotations" ]] || exit 1
    check="\${endpoint%/annotations*}"
    check="\${check##*/}"
    jq -e --arg check "$check" '.[$check]' <<< "$FAKE_ANNOTATIONS"
    ;;
  *) exit 2 ;;
esac
`,
  { mode: 0o755 },
);
afterAll(() => {
  rmSync(fakeGhDirectory, { force: true, recursive: true });
});

// Unarmed pull requests and merge groups without armed proof, unless the
// planned outputs say otherwise.
const heavyProofEnv = (
  event: EvaluateResultOptions["event"],
  plannedOutputs: Record<string, string>,
) => ({
  HEAVY_PROOF:
    plannedOutputs["heavy_proof"] ?? String(event !== EVENT.pullRequest),
  HEAVY_PROOF_JOBS: resultStep.env["HEAVY_PROOF_JOBS"] ?? "",
  MERGE_GROUP_HEAVY_KEEP: resultStep.env["MERGE_GROUP_HEAVY_KEEP"] ?? "",
  ARMED_PROOF_SOURCE_RUN_ID: plannedOutputs["armed_proof_source_run_id"] ?? "",
  ARMED_DELTA: plannedOutputs["armed_delta"] ?? "false",
  NORMAL_SOURCE_RUN_ID: plannedOutputs["normal_source_run_id"] ?? "",
  RUN_REQUIRED: plannedOutputs["run_required"] ?? "true",
});

// The ci-result step as GitHub would run it, with every job succeeding and
// every scope selected unless the options say otherwise.
// ci-result's view of the planner's heavy-suite reuse verdict.
const prHeavyEnv = (plannedOutputs: Record<string, string>) => ({
  PR_HEAVY_SUITES: plannedOutputs["pr_heavy_suites"] ?? "run",
  PR_HEAVY_SOURCE_RUN_ID: plannedOutputs["pr_heavy_source_run_id"] ?? "",
  PR_HEAVY_SOURCE_SHA: plannedOutputs["pr_heavy_source_sha"] ?? "",
  PR_HEAVY_JOBS: JSON.stringify(PR_HEAVY_JOBS),
});

const resultGateCase = ({
  event,
  results,
  suiteDepth = event === EVENT.pullRequest
    ? SUITE_DEPTH.fast
    : SUITE_DEPTH.full,
  unplannedScopes = [],
  plannedOutputs = {},
  trusted = "true",
  liveDraft,
  suiteResults = {},
  cancellationEvidence = "timeout",
  apiFailure,
  missingJob = false,
  matrixTimeoutSibling = false,
  embeddedStepFailure = false,
  jobConclusion,
  heavyOnly = false,
  outcomeScript = resultStep.run,
  newerRun = "same-group",
  queuedCancellation,
  metadataCodeRun,
}: EvaluateResultOptions): BashCase => {
  const plan = Object.fromEntries(
    [
      ...Object.values(jobScopes),
      ...Object.values(fastJobScopes),
      ...Object.values(foldedSuites).flatMap(Object.values),
    ].flatMap((scope) =>
      scope === null
        ? []
        : [[scope, unplannedScopes.includes(scope) ? "false" : "true"]],
    ),
  );
  const needs = Object.fromEntries(
    resultJob.needs.map((job) => [
      job,
      {
        result: results[job] ?? "success",
        outputs: Object.fromEntries(
          Object.keys(foldedSuites[job] ?? {}).map((suite) => [
            suite,
            suiteResults[suite] ?? "success",
          ]),
        ),
      },
    ]),
  );
  const group =
    "CI Checks-ci-dispatch-refs/heads/ci/result-cancellation-signal-proof";
  const annotations = {
    superseded: supersessionAnnotations,
    timeout: timeoutAnnotations,
    "step-timeout": [
      {
        message:
          "The action 'Run Playwright shard' has timed out after 7 minutes.",
      },
    ],
    missing: [],
    "wrong-group": supersessionAnnotations.map(({ message }) => ({
      message: message.replace(group, "a different concurrency group"),
    })),
  }[cancellationEvidence];
  const jobs = [];
  const checkAnnotations: Record<string, unknown> = {};
  for (const [job, result] of Object.entries(needs)) {
    if (
      result.result !== "cancelled" &&
      result.result !== "failure" &&
      result.result !== "timed_out"
    ) {
      continue;
    }
    const name =
      v.parse(v.object({ name: v.optional(v.string()) }), ciJobs[job]).name ??
      job;
    const checkId: string = String(jobs.length + 10);
    jobs.push({
      name:
        name.replace(/\$\{\{[^}]+\}\}/gu, "fixture") +
        (job === "ci-tests" ? " (api-1)" : ""),
      conclusion: jobConclusion ?? result.result,
      html_url: `https://example.test/jobs/${checkId}`,
      steps: embeddedStepFailure
        ? [{ name: "Validate contract", number: 3, conclusion: "failure" }]
        : [],
      check_run_url: `https://api.github.com/repos/${PULL_REQUEST.repo}/check-runs/${checkId}`,
    });
    checkAnnotations[checkId] = [annotations];
  }
  if (matrixTimeoutSibling) {
    const checkId = "999";
    jobs.push({
      name: "ci-tests (api-2)",
      conclusion: "cancelled",
      check_run_url: `https://api.github.com/repos/${PULL_REQUEST.repo}/check-runs/${checkId}`,
    });
    checkAnnotations[checkId] = [timeoutAnnotations];
  }
  if (queuedCancellation !== undefined) {
    const checkId = queuedJob.check_run_url.split("/").at(-1);
    if (checkId === undefined) {
      throw new TypeError("Recorded queued job has no check run ID");
    }
    jobs.push({
      name: queuedJob.name,
      conclusion: queuedJob.conclusion,
      check_run_url:
        queuedCancellation === "with-check" ? queuedJob.check_run_url : null,
    });
    checkAnnotations[checkId] = queuedJob.annotations;
  }
  const currentRun = {
    id: 123,
    name: "CI Checks",
    workflow_id: 42,
    run_number: 100,
    created_at: "2026-10-01T17:42:59Z",
    head_branch: "ci/result-job-annotation-proof",
    event,
    pull_requests:
      event === EVENT.pullRequest
        ? [{ number: Number(PULL_REQUEST.number) }]
        : [],
  };
  let createdAt = "2026-10-01T17:43:00Z";
  if (newerRun === "older") {
    createdAt = "2026-10-01T17:42:58Z";
  } else if (newerRun === "same-time") {
    createdAt = currentRun.created_at;
  }
  const successor = {
    ...currentRun,
    id: newerRun === "older" ? 122 : 124,
    workflow_id: newerRun === "other-workflow" ? 43 : 42,
    run_number: newerRun === "older" ? 99 : 101,
    created_at: createdAt,
    head_branch:
      newerRun === "other-ref" ? "other-branch" : currentRun.head_branch,
    event: newerRun === "other-event" ? "push" : event,
    pull_requests:
      newerRun === "other-pr" ? [{ number: 8 }] : currentRun.pull_requests,
  };
  const codeRun = metadataCodeRunFixtures(metadataCodeRun);
  return {
    flags: ["-eu"],
    script: renderResultInputs(outcomeScript, {
      needs: JSON.stringify(needs),
      plan: JSON.stringify({
        ...plan,
        ...plannedOutputs,
        suite_depth: suiteDepth,
        trusted,
      }),
    }),
    args: [],
    env: {
      GH_RETRY_SCRIPT: nodePath.resolve(import.meta.dir, "gh-retry.sh"),
      EVENT: event,
      COVERAGE_PROFILE: "normal-v1",
      PILOT_FAST_JOBS: "[]",
      QUEUE_VALIDATION: "false",
      QUEUE_REQUIRED_JOBS: JSON.stringify(queueAdmittedJobs({ jobs: ciJobs })),
      PR_ACTION: "synchronize",
      PR_DEPTH_ONLY: "false",
      PR_DEPTH_REUSED: plannedOutputs["pr_depth_reused"] ?? "false",
      PR_DEPTH_SOURCE_RUN_ID: plannedOutputs["pr_depth_source_run_id"] ?? "99",
      PR_DEPTH_JOBS: JSON.stringify(prDepthJobs({ jobs: ciJobs })),
      PLAN_CONFIG: "{}",
      ...prHeavyEnv(plannedOutputs),
      QUEUE_DEPTH: plannedOutputs["queue_depth"] ?? "full",
      HEAVY_ONLY: String(heavyOnly),
      HEAVY_JOBS: JSON.stringify(mainHeavyJobNames),
      THIN_JOBS: JSON.stringify(thinJobs({ jobs: ciJobs })),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_STEP_SUMMARY: "/dev/null",
      FAKE_API_FAILURE: apiFailure ?? "",
      FAKE_CURRENT_RUN: JSON.stringify(currentRun),
      FAKE_RUNS: JSON.stringify([
        { workflow_runs: newerRun === "none" ? [] : [successor] },
      ]),
      FAKE_JOBS: JSON.stringify([{ jobs: missingJob ? [] : jobs }]),
      FAKE_ANNOTATIONS: JSON.stringify(checkAnnotations),
      FAKE_LIVE_DRAFT: liveDraft === undefined ? "" : String(liveDraft),
      FAKE_CODE_STATE: codeRun.state,
      FAKE_CODE_RUNS: JSON.stringify([{ workflow_runs: codeRun.runs }]),
      FAKE_CODE_JOBS: JSON.stringify(codeRun.finalJobs),
      FAKE_CODE_JOBS_FIRST: JSON.stringify(codeRun.firstJobs),
      FAKE_CODE_RECORD: JSON.stringify(codeRun.record),
      JOB_SCOPES: resultStep.env["JOB_SCOPES"] ?? "",
      FOLDED_SUITES: resultStep.env["FOLDED_SUITES"] ?? "",
      FAST_REQUIRED: resultStep.env["FAST_REQUIRED"] ?? "",
      FAST_JOB_SCOPES: resultStep.env["FAST_JOB_SCOPES"] ?? "",
      ...heavyProofEnv(event, plannedOutputs),
      PATH: `${fakeGhDirectory}:${process.env["PATH"] ?? ""}`,
      PR_NUMBER: event === EVENT.pullRequest ? PULL_REQUEST.number : "",
      REPO: PULL_REQUEST.repo,
      HEAD_SHA: "a".repeat(40),
      METADATA_ONLY: codeRun.enabled,
      RUN_REQUIRED: codeRun.runRequired,
      PLAN_RESULT: needs["ci-plan"]?.result ?? "",
      SUITE_DEPTH: suiteDepth,
      TRUSTED: trusted,
    },
  };
};

const evaluateResults = <T>(
  items: readonly T[],
  toOptions: (item: T) => EvaluateResultOptions,
) => runBashBatch(items, (item) => resultGateCase(toOptions(item)));

const evaluateResult = (options: EvaluateResultOptions) =>
  onlyOutcome(evaluateResults([options], (item) => item)).exitCode;

type ExpectedResultGate = {
  label: string;
  options: EvaluateResultOptions;
  exitCode: number;
};

const expectResultGates = (gates: readonly ExpectedResultGate[]) => {
  for (const { item, exitCode } of evaluateResults(
    gates,
    ({ options }) => options,
  )) {
    expect(exitCode, item.label).toBe(item.exitCode);
  }
};

const FULL_DEPTH_PREDICATE = "needs.ci-plan.outputs.suite_depth == 'full'";
const heavyJobs = Object.entries(ciJobs).flatMap(([job, body]) =>
  jobIf(body).includes(FULL_DEPTH_PREDICATE) ||
  jobIf(body).includes(HEAVY_PROOF_GATE) ||
  jobIf(body).includes("github.event_name != 'pull_request' && (")
    ? [job]
    : [],
);
const gatedJobs = resultJob.needs.filter((job) => job !== "ci-plan");

const reportOnlyJobs = Object.entries(ciJobs).flatMap(([job, body]) =>
  v.parse(v.object({ "continue-on-error": v.optional(v.boolean()) }), body)[
    "continue-on-error"
  ]
    ? [job]
    : [],
);
// Jobs that only collect diagnostics after a gated job failed. ci-result does
// not wait for them: the failure they report already fails the run.
const diagnosticJobs = Object.entries(ciJobs).flatMap(([job, body]) =>
  Object.hasOwn(PR_CODE_QUALITY_CANCEL_JOBS, job) ||
  (jobIf(body).includes("needs.") &&
    /needs\.[\w-]+\.result == 'failure'/u.test(jobIf(body)))
    ? [job]
    : [],
);

const failedGatedJobs = fc.tuple(
  fc.constantFrom(...gatedJobs),
  fc.constantFrom("failure", "timed_out", ""),
  fc.constantFrom(...Object.values(EVENT)),
);

const activeJobForEvent = (job: string, event: Event) => {
  if (event === EVENT.pullRequest && job === "ci-quick-checks") {
    return "pr-heavy-gate";
  }
  if (event !== EVENT.pullRequest && job === "pr-heavy-gate") {
    return "ci-quick-checks";
  }
  return job;
};

test("the result gate evaluates every job in the workflow", () => {
  expect(new Set(resultJob.needs)).toEqual(
    new Set(
      Object.keys(ciJobs).filter(
        (job) =>
          job !== "ci-result" &&
          // It only shortens a failing run; gating on it would let a failed
          // cancellation request block the result (bound above).
          job !== CANCEL_REUSABLE_JOB &&
          !MAIN_ONLY_JOBS.has(job) &&
          !reportOnlyJobs.includes(job) &&
          !diagnosticJobs.includes(job),
      ),
    ),
  );
  for (const job of diagnosticJobs) {
    const helperDependency = Object.entries(PR_CODE_QUALITY_CANCEL_JOBS).find(
      ([helper]) => helper === job,
    )?.[1];
    const failedOn = helperDependency
      ? [helperDependency]
      : [
          ...jobIf(ciJobs[job]).matchAll(
            /needs\.([\w-]+)\.result == 'failure'/gu,
          ),
        ].map((match) => match[1] ?? "");
    expect(failedOn.length, job).toBeGreaterThan(0);
    for (const gated of failedOn) {
      expect(resultJob.needs, `${job} runs on ${gated}`).toContain(gated);
    }
    expect(jobIf(ciJobs[job]), job).not.toContain("always()");
  }
  expect(reportOnlyJobs).toEqual([]);
  for (const job of MAIN_ONLY_JOBS) {
    expect(jobIf(ciJobs[job]), job).toContain(
      "github.ref == 'refs/heads/main'",
    );
  }
  expect(resultJob.needs).not.toContain("migration-exact-base-upgrade");
  expect(jobScopes).not.toHaveProperty("migration-exact-base-upgrade");
  for (const {
    item: { label },
    exitCode,
  } of evaluateResults(
    drawPropertySamples(failedGatedJobs, { numRuns: 100 }),
    ({ value: [job, result, event] }) => ({
      event,
      results: {
        [activeJobForEvent(job, event)]: result,
      },
    }),
  )) {
    expect(exitCode, label).toBe(1);
  }
});

test("each job's plan scope is the ci-plan output its `if:` selects it by", () => {
  const declaredAdditionalScopes = {
    "service-suites": [
      "corpus_suites_required",
      "Corpus changes start the shared service job without opting PRs into Postgres or Valkey steps.",
    ],
  } as const satisfies Record<string, readonly [string, string]>;
  expect(new Set(Object.keys(jobScopes))).toEqual(new Set(gatedJobs));
  for (const job of gatedJobs) {
    const selectedBy = [
      ...jobIf(ciJobs[job]).matchAll(
        /needs\.ci-plan\.outputs\.(\w+_required) == 'true'/gu,
      ),
    ].map((match) => match[1]);
    const scope = jobScopes[job];
    const additionalScope = Object.entries(declaredAdditionalScopes)
      .find(([name]) => name === job)?.[1]
      .at(0);
    expect(selectedBy, job).toEqual([
      ...(scope === null ? [] : [scope]),
      ...(additionalScope === undefined ? [] : [additionalScope]),
      ...(fastJobScopes[job] && fastJobScopes[job] !== scope
        ? [fastJobScopes[job]]
        : []),
    ]);
  }
});

const unsuccessfulFullDepthJobs = fc.tuple(
  fc.constantFrom(...gatedJobs),
  fc.constantFrom("skipped", "cancelled", "failure"),
  fc.constantFrom(...FULL_DEPTH_EVENTS),
);

test("a full-depth run fails every planned job that did not succeed", () => {
  for (const {
    item: { label },
    exitCode,
  } of evaluateResults(
    drawPropertySamples(unsuccessfulFullDepthJobs, { numRuns: 100 }),
    ({ value: [job, result, event] }) => ({
      event,
      results: {
        [activeJobForEvent(job, event)]: result,
      },
      suiteDepth: SUITE_DEPTH.full,
    }),
  )) {
    expect(exitCode, label).toBe(1);
  }
});

test("a full-depth run passes jobs whose scope was not planned only when skipped", () => {
  const gates: ExpectedResultGate[] = [];
  for (const job of gatedJobs) {
    const scope = jobScopes[job];
    if (scope === undefined || scope === null) {
      continue;
    }
    for (const event of FULL_DEPTH_EVENTS) {
      const unplanned = { event, unplannedScopes: [scope] };
      gates.push(
        {
          label: `${event} ${job} skipped`,
          options: { ...unplanned, results: { [job]: "skipped" } },
          exitCode: 0,
        },
        {
          label: `${event} ${job} cancelled`,
          options: { ...unplanned, results: { [job]: "cancelled" } },
          exitCode: 1,
        },
      );
    }
  }
  expectResultGates(gates);
}, 30_000);

// A pull request always plans `fast`; a manual run plans the depth it was
// dispatched with. Both can be superseded by a newer run.
const FAST_DEPTH_EVENTS = [EVENT.pullRequest, EVENT.workflowDispatch] as const;

test("PR-depth evidence never replaces admitted merge-group checks", () => {
  const depthJobs = prDepthJobs({ jobs: ciJobs });
  const gates: ExpectedResultGate[] = [];
  for (const queueDepth of ["thin", "full"] as const) {
    for (const reused of ["false", "true"] as const) {
      const plannedOutputs = {
        queue_depth: queueDepth,
        pr_depth_reused: reused,
        pr_depth_source_run_id: "99",
      };
      gates.push({
        label: `${queueDepth}/${reused}/success`,
        options: { event: EVENT.mergeGroup, plannedOutputs, results: {} },
        exitCode: 0,
      });
      for (const job of depthJobs) {
        expect(
          runsAtDepth(jobIf(ciJobs[job]), {
            event: EVENT.mergeGroup,
            depth: "full",
            queueDepth,
            prDepthReused: reused,
          }),
          `${job}/${queueDepth}/${reused}`,
        ).toBe(true);
        for (const outcome of ["skipped", "failure", "cancelled"]) {
          gates.push({
            label: `${job}/${queueDepth}/${reused}/${outcome}`,
            options: {
              event: EVENT.mergeGroup,
              plannedOutputs,
              results: { [job]: outcome },
            },
            exitCode: 1,
          });
        }
      }
    }
  }
  expectResultGates(gates);
}, 35_000);

test("CI result rejects a failed check leg after independent guards finish", () => {
  for (const event of [EVENT.mergeGroup, EVENT.pullRequest]) {
    const results = Object.fromEntries(
      resultJob.needs.map((job) => [job, "success"]),
    );
    expect(evaluateResult({ event, results })).toBe(0);
    for (const leg of [
      "ci-checks-generated",
      "ci-checks-policy",
      "ci-checks-rest",
    ]) {
      expect(resultJob.needs).toContain(leg);
      expect(
        evaluateResult({ event, results: { ...results, [leg]: "failure" } }),
        leg,
      ).toBe(1);
    }
  }
});

// timeout: Runs the bounded Bash and jq evidence matrix in real subprocesses.
test.each(resultJob.needs)(
  "failed %s cannot pass with cancelled siblings or supersession evidence",
  (failedJob) => {
    const gates: ExpectedResultGate[] = [];
    for (const event of [EVENT.mergeGroup, EVENT.pullRequest]) {
      if (
        (event === EVENT.pullRequest && failedJob === "ci-quick-checks") ||
        (event !== EVENT.pullRequest && failedJob === "pr-heavy-gate")
      ) {
        continue;
      }
      for (const cancellationEvidence of ["missing", "superseded"] as const) {
        const results = Object.fromEntries(
          resultJob.needs.map((job) => [job, "cancelled"]),
        );
        results["ci-plan"] = "success";
        results[failedJob] = "failure";
        gates.push({
          label: `${event} ${failedJob} ${cancellationEvidence}`,
          options: { event, results, cancellationEvidence },
          exitCode: 1,
        });
      }
    }
    expectResultGates(gates);
  },
  30_000,
);

test("a self-cancelled merge group fails even when GitHub marks the failing job cancelled", () => {
  for (const cancellationEvidence of ["missing", "superseded"] as const) {
    const results = Object.fromEntries(
      resultJob.needs.map((job) => [
        job,
        job === "ci-plan" ? "success" : "cancelled",
      ]),
    );
    expect(
      evaluateResult({
        event: EVENT.mergeGroup,
        results,
        cancellationEvidence,
      }),
    ).toBe(1);
  }
});

test.each(resultJob.needs)(
  "cancelled %s passes only with a newer run in the same group and no timeout",
  (job) => {
    for (const event of FAST_DEPTH_EVENTS) {
      for (const cancellationEvidence of [
        "superseded",
        "timeout",
        "missing",
        "wrong-group",
      ] as const) {
        expect(
          evaluateResult({
            event,
            results: { [activeJobForEvent(job, event)]: "cancelled" },
            suiteDepth: SUITE_DEPTH.fast,
            cancellationEvidence,
          }),
          `${job} ${event} ${cancellationEvidence}`,
        ).toBe(cancellationEvidence === "timeout" ? 1 : 0);
      }
    }
  },
);

test("ci-result diagnoses timeouts before main-heavy cancellation or supersession", () => {
  const cases = [false, true].flatMap((heavyOnly) => [
    {
      label: `annotation timeout, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "timeout" as const,
      jobConclusion: undefined,
      embeddedStepFailure: false,
      expectedExit: 1,
      expectedDiagnostic: true,
    },
    {
      label: `step timeout, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "step-timeout" as const,
      jobConclusion: "failure" as const,
      embeddedStepFailure: true,
      expectedExit: 1,
      expectedDiagnostic: true,
    },
    {
      label: `timed_out conclusion, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "superseded" as const,
      jobConclusion: "timed_out" as const,
      embeddedStepFailure: false,
      expectedExit: 1,
      expectedDiagnostic: true,
    },
    {
      label: `ordinary supersession, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "superseded" as const,
      jobConclusion: undefined,
      embeddedStepFailure: false,
      expectedExit: heavyOnly ? 1 : 0,
      expectedDiagnostic: false,
    },
    {
      label: `failed job, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "superseded" as const,
      jobConclusion: "failure" as const,
      embeddedStepFailure: false,
      expectedExit: 1,
      expectedDiagnostic: false,
    },
    {
      label: `failed step, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "superseded" as const,
      jobConclusion: undefined,
      embeddedStepFailure: true,
      expectedExit: 1,
      expectedDiagnostic: false,
    },
  ]);
  for (const { item, exitCode, stdout } of evaluateResults(
    cases,
    ({
      heavyOnly,
      cancellationEvidence,
      jobConclusion,
      embeddedStepFailure,
    }) => ({
      event: EVENT.workflowDispatch,
      suiteDepth: heavyOnly ? SUITE_DEPTH.full : SUITE_DEPTH.fast,
      results: {
        "e2e-production-shard":
          jobConclusion === "failure" ? "failure" : "cancelled",
      },
      heavyOnly,
      cancellationEvidence,
      ...(jobConclusion === undefined ? {} : { jobConclusion }),
      embeddedStepFailure,
    }),
  )) {
    expect(exitCode, item.label).toBe(item.expectedExit);
    if (item.expectedDiagnostic) {
      expect(stdout, item.label).toContain(
        "CI job timed out: e2e-production-shard",
      );
    } else {
      expect(stdout, item.label).not.toContain("CI job timed out:");
      if (item.heavyOnly && item.label.startsWith("ordinary supersession")) {
        expect(stdout).toContain("Main heavy suites were cancelled.");
      }
    }
  }

  const timeoutDetectionDisabled = resultStep.run.replace(
    'contains("has exceeded the maximum execution time")',
    "false",
  );
  expect(timeoutDetectionDisabled).not.toBe(resultStep.run);
  const mutated = onlyOutcome(
    evaluateResults([null], () => ({
      event: EVENT.workflowDispatch,
      results: { "e2e-production-shard": "cancelled" },
      heavyOnly: false,
      suiteDepth: SUITE_DEPTH.fast,
      cancellationEvidence: "timeout",
      outcomeScript: timeoutDetectionDisabled,
    })),
  );
  expect(mutated.stdout).not.toContain("CI job timed out:");
});

test("a run that passes as superseded records no completion evidence", () => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-result-evidence-"));
  try {
    const cases = [
      { label: "complete", results: {} },
      ...resultJob.needs
        .filter((job) => job !== "ci-plan")
        .map((job) => ({ label: job, results: { [job]: "cancelled" } })),
    ];
    for (const { item, exitCode, stdout } of runBashBatch(cases, (entry) => {
      const base = resultGateCase({
        event: EVENT.pullRequest,
        results:
          entry.label === "complete"
            ? entry.results
            : {
                [activeJobForEvent(entry.label, EVENT.pullRequest)]:
                  "cancelled",
              },
        suiteDepth: SUITE_DEPTH.fast,
        cancellationEvidence: "superseded",
      });
      return {
        ...base,
        env: {
          ...base.env,
          GITHUB_OUTPUT: nodePath.join(directory, entry.label),
          RUN_REQUIRED: "true",
          COMPLETION_MARKER: "ci-completed-v5-fixture",
          HEAD_SHA: "a".repeat(40),
          BASE_SHA: "b".repeat(40),
          HEAD_REPO_ID: "456",
          PATCH_ID: "c".repeat(40),
          WORKFLOW_VERSION: "d".repeat(40),
          TESTED_TREE: "f".repeat(40),
          WORKFLOW_TREE: "1".repeat(40),
          PLAN_CONFIG: "e".repeat(64),
          PR_DEPTH_JOBS: JSON.stringify(prDepthJobs({ jobs: ciJobs })),
        },
      };
    })) {
      expect(exitCode, item.label).toBe(0);
      const output = nodePath.join(directory, item.label);
      const written = existsSync(output) ? readFileSync(output, "utf-8") : "";
      expect(written.includes("evidence="), item.label).toBe(
        item.label === "complete",
      );
      if (item.label !== "complete") {
        expect(stdout, item.label).toContain("superseded");
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("completion evidence names every missing evidence input without changing the verdict", () => {
  const directory = mkdtempSync(
    nodePath.join(tmpdir(), "ci-result-evidence-inputs-"),
  );
  const evidenceInputBlock =
    /evidence_inputs=\(\n(?<inputs>[\s\S]*?)\n\s*\)/u.exec(resultStep.run)
      ?.groups?.["inputs"];
  if (evidenceInputBlock === undefined) {
    throw new TypeError("Evaluate CI outcome has no evidence input list");
  }
  const requiredInputs = [
    ...evidenceInputBlock.matchAll(
      /"(?<name>[A-Z_]+):[^:"\n]+:(?<kind>[^"\n]+)"/gu,
    ),
  ]
    .filter((match) => !match.groups?.["kind"]?.startsWith("optional-"))
    .map((match) => match.groups?.["name"] ?? "");
  expect(requiredInputs).not.toContain("");
  try {
    const cases: {
      label: string;
      invalid?: string;
      mutation?: "malformed" | "missing";
    }[] = [
      { label: "complete" },
      ...requiredInputs.flatMap((invalid) => [
        { label: `${invalid} missing`, invalid, mutation: "missing" as const },
        {
          label: `${invalid} malformed`,
          invalid,
          mutation: "malformed" as const,
        },
      ]),
    ];
    for (const { item, exitCode, stdout } of runBashBatch(cases, (entry) => {
      let invalidation = "";
      if (entry.invalid !== undefined) {
        if (entry.mutation === "missing") {
          invalidation = `unset ${entry.invalid}\n`;
        } else {
          const value = ["COMPLETION_MARKER", "COVERAGE_PROFILE"].includes(
            entry.invalid,
          )
            ? "''"
            : "malformed";
          invalidation = `${entry.invalid}=${value}\n`;
        }
      }
      const outcomeScript = resultStep.run.replace(
        "# Completion evidence lets a later unchanged-head run skip every\n",
        () =>
          `${invalidation}# Completion evidence lets a later unchanged-head run skip every\n`,
      );
      expect(outcomeScript === resultStep.run, entry.label).toBe(
        entry.invalid === undefined,
      );
      const base = resultGateCase({
        event: EVENT.pullRequest,
        results: {},
        suiteDepth: SUITE_DEPTH.fast,
        outcomeScript,
      });
      return {
        ...base,
        env: {
          ...base.env,
          GITHUB_OUTPUT: nodePath.join(directory, entry.label),
          RUN_REQUIRED: "true",
          COMPLETION_MARKER: "ci-completed-v6-fixture",
          HEAD_SHA: "a".repeat(40),
          BASE_SHA: "b".repeat(40),
          HEAD_REPO_ID: "456",
          PATCH_ID: "c".repeat(40),
          WORKFLOW_VERSION: "d".repeat(40),
          TESTED_TREE: "f".repeat(40),
          WORKFLOW_TREE: "1".repeat(40),
          PLAN_CONFIG: "e".repeat(64),
          PR_DEPTH_JOBS: JSON.stringify(prDepthJobs({ jobs: ciJobs })),
        },
      };
    })) {
      expect(exitCode, item.label).toBe(0);
      const output = nodePath.join(directory, item.label);
      const written = existsSync(output) ? readFileSync(output, "utf-8") : "";
      expect(written.includes("evidence="), item.label).toBe(
        item.invalid === undefined,
      );
      if (item.invalid !== undefined) {
        expect(stdout, item.label).toContain(
          `Completion evidence was skipped because ${item.invalid} is missing or malformed.`,
        );
        expect(stdout, item.label).toContain(
          `::error::Invalid or missing completion evidence input: ${item.invalid}.`,
        );
        expect(stdout, item.label).not.toContain(
          "Not every planned CI job succeeded",
        );
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// The run's own record of which jobs it required, as ci-result writes it.
const requiredRecordSchema = v.strictObject({
  version: v.literal(1),
  event: v.string(),
  head_sha: v.nullable(v.string()),
  base_sha: v.nullable(v.string()),
  run_id: v.nullable(v.number()),
  run_attempt: v.nullable(v.number()),
  depth: v.nullable(v.string()),
  coverage_profile: v.nullable(v.string()),
  reused_from_run_id: v.nullable(v.number()),
  basis: v.picklist(["evaluated", "pass_through"]),
  pass_through_reason: v.nullable(
    v.picklist(["enqueued", "draft", "superseded", "metadata", "reused"]),
  ),
  required: v.array(
    v.strictObject({ job: v.string(), conclusion: v.string() }),
  ),
  not_required: v.array(v.string()),
  verdict: v.picklist(["success", "failure"]),
});
type RequiredRecordCase = {
  label: string;
  options: EvaluateResultOptions;
  env?: Record<string, string>;
};
const recordRequiredJobs = (cases: readonly RequiredRecordCase[]) => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-required-record-"));
  try {
    return runBashBatch(cases, (entry) => {
      const base = resultGateCase(entry.options);
      return {
        ...base,
        env: {
          ...base.env,
          ...entry.env,
          GITHUB_OUTPUT: nodePath.join(directory, entry.label),
        },
      };
    }).map(({ item, exitCode, stdout }) => {
      const output = nodePath.join(directory, item.label);
      const records = (existsSync(output) ? readFileSync(output, "utf-8") : "")
        .split("\n")
        .filter((line) => line.startsWith("required_summary="));
      expect(records.length, `${item.label}: ${stdout}`).toBe(1);
      return {
        label: item.label,
        exitCode,
        record: v.parse(
          requiredRecordSchema,
          JSON.parse(records[0]?.slice("required_summary=".length) ?? ""),
        ),
      };
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};
// Jobs ci-result does not wait on, and ci-plan, which it reads as the plan.
const structuralJobs = Object.keys(ciJobs).filter(
  (job) => job === "ci-plan" || !resultJob.needs.includes(job),
);

test("the required-jobs record names every workflow job once and carries the verdict", () => {
  expect(new Set(structuralJobs)).toEqual(
    new Set([
      "ci-plan",
      "ci-result",
      CANCEL_REUSABLE_JOB,
      ...MAIN_ONLY_JOBS,
      ...reportOnlyJobs,
      ...diagnosticJobs,
    ]),
  );
  const skippedSuites = Object.fromEntries(
    gatedJobs.map((job) => [job, "skipped"]),
  );
  const outcomes = recordRequiredJobs([
    {
      label: "merge-group-success",
      options: {
        event: EVENT.mergeGroup,
        results: {},
        suiteDepth: SUITE_DEPTH.full,
      },
      env: { HEAD_SHA: "a".repeat(40), BASE_SHA: "b".repeat(40) },
    },
    {
      label: "merge-group-failure",
      options: {
        event: EVENT.mergeGroup,
        results: { "ci-tests": "failure" },
        suiteDepth: SUITE_DEPTH.full,
        cancellationEvidence: "missing",
      },
    },
    {
      label: "pull-request-fast",
      options: {
        event: EVENT.pullRequest,
        results: {},
        suiteDepth: SUITE_DEPTH.fast,
      },
      env: { HEAD_SHA: "c".repeat(40), BASE_SHA: "d".repeat(40) },
    },
    {
      // A job outside the fast-required set still fails the verdict.
      label: "pull-request-fast-outside-failure",
      options: {
        event: EVENT.pullRequest,
        results: { "e2e-vite-canary": "failure" },
        suiteDepth: SUITE_DEPTH.fast,
      },
    },
    {
      // A verified supersession accepts a cancelled job but evaluated
      // nothing: the record names the job and passes through as superseded.
      label: "pull-request-fast-superseded-cancel",
      options: {
        event: EVENT.pullRequest,
        results: { "e2e-vite-canary": "cancelled" },
        suiteDepth: SUITE_DEPTH.fast,
        cancellationEvidence: "superseded",
      },
    },
    {
      label: "pull-request-reused",
      options: {
        event: EVENT.pullRequest,
        results: skippedSuites,
        suiteDepth: SUITE_DEPTH.fast,
      },
      env: {
        RUN_REQUIRED: "false",
        COMPLETED_RUN_ID: "99",
        METADATA_ONLY: "false",
      },
    },
    {
      // A main heavy-only run evaluates the derived heavy set.
      label: "main-heavy-only-success",
      options: {
        event: EVENT.workflowDispatch,
        results: {},
        suiteDepth: SUITE_DEPTH.full,
        heavyOnly: true,
      },
    },
    {
      // Arming a pull request reruns CI only to hand validation to the queue.
      label: "pull-request-enqueued",
      options: {
        event: EVENT.pullRequest,
        results: {},
        suiteDepth: SUITE_DEPTH.fast,
      },
      env: { PR_ACTION: "enqueued", QUEUE_VALIDATION: "true" },
    },
  ]);
  const byLabel = new Map(outcomes.map((outcome) => [outcome.label, outcome]));
  const take = (label: string) =>
    byLabel.get(label) ?? panic(`Missing record case ${label}`);

  for (const { label, exitCode, record } of outcomes) {
    const required = record.required.map(({ job }) => job);
    const named = [...required, ...record.not_required, ...structuralJobs];
    expect(named.toSorted(compareCodeUnit), label).toEqual(
      Object.keys(ciJobs).toSorted(compareCodeUnit),
    );
    expect(record.verdict, label).toBe(exitCode === 0 ? "success" : "failure");
    expect(record.run_id, label).toBe(123);
    expect(record.run_attempt, label).toBe(1);
    expect(record.coverage_profile, label).toBe("normal-v1");
  }

  const success = take("merge-group-success");
  expect(success.exitCode).toBe(0);
  expect(success.record).toMatchObject({
    event: "merge_group",
    head_sha: "a".repeat(40),
    base_sha: "b".repeat(40),
    depth: "full",
    reused_from_run_id: null,
    verdict: "success",
  });
  expect(success.record.required.map(({ job }) => job)).toContain("ci-tests");
  for (const { job, conclusion } of success.record.required) {
    expect(conclusion, job).toBe("success");
  }

  const failure = take("merge-group-failure");
  expect(failure.exitCode).toBe(1);
  expect(failure.record.verdict).toBe("failure");
  expect(failure.record.base_sha).toBeNull();
  expect(failure.record.required).toContainEqual({
    job: "ci-tests",
    conclusion: "failure",
  });

  const fast = take("pull-request-fast");
  expect(fast.exitCode).toBe(0);
  expect(fast.record).toMatchObject({
    event: "pull_request",
    head_sha: "c".repeat(40),
    base_sha: "d".repeat(40),
    depth: "fast",
    verdict: "success",
  });
  const fastRequired = fast.record.required.map(({ job }) => job);
  expect(fastRequired).toContain("pr-heavy-gate");
  // A fast run leaves its heavy suites to the queue.
  expect(fast.record.not_required).toContain("e2e-vite-canary");
  expect(fastRequired.length).toBeLessThan(success.record.required.length);

  // The record holds every job the verdict counted, not only the fast set.
  const outside = take("pull-request-fast-outside-failure");
  expect(outside.exitCode).toBe(1);
  expect(outside.record.verdict).toBe("failure");
  expect(outside.record.required).toContainEqual({
    job: "e2e-vite-canary",
    conclusion: "failure",
  });
  expect(outside.record.not_required).not.toContain("e2e-vite-canary");

  const superseded = take("pull-request-fast-superseded-cancel");
  expect(superseded.record.required).toContainEqual({
    job: "e2e-vite-canary",
    conclusion: "cancelled",
  });
  expect(superseded.record.not_required).not.toContain("e2e-vite-canary");
  expect(superseded.exitCode).toBe(0);
  expect(superseded.record).toMatchObject({
    verdict: "success",
    basis: "pass_through",
    pass_through_reason: "superseded",
  });

  // Every evaluating branch says so; an exit that evaluated nothing names
  // why, so a consumer never reads its success as evidence.
  for (const label of [
    "merge-group-success",
    "merge-group-failure",
    "pull-request-fast",
    "pull-request-fast-outside-failure",
  ]) {
    expect(take(label).record, label).toMatchObject({
      basis: "evaluated",
      pass_through_reason: null,
    });
  }

  // A heavy-only run counts its heavy suites as required, never as
  // not_required, so its success is evidence for exactly that set.
  const heavy = take("main-heavy-only-success");
  expect(heavy.exitCode).toBe(0);
  expect(heavy.record).toMatchObject({
    depth: "heavy",
    verdict: "success",
    basis: "evaluated",
    pass_through_reason: null,
  });
  const heavyRequired = heavy.record.required.map(({ job }) => job);
  expect(heavyRequired.length).toBeGreaterThan(0);
  expect(heavyRequired.toSorted(compareCodeUnit)).toEqual(
    mainHeavyJobNames
      .filter((job) => resultJob.needs.includes(job))
      .toSorted(compareCodeUnit),
  );
  for (const { job, conclusion } of heavy.record.required) {
    expect(conclusion, job).toBe("success");
  }

  const reused = take("pull-request-reused");
  expect(reused.exitCode).toBe(0);
  expect(reused.record).toMatchObject({
    reused_from_run_id: 99,
    required: [],
    verdict: "success",
    basis: "pass_through",
    pass_through_reason: "reused",
  });

  const enqueued = take("pull-request-enqueued");
  expect(enqueued.exitCode).toBe(0);
  expect(enqueued.record).toMatchObject({
    required: [],
    verdict: "success",
    basis: "pass_through",
    pass_through_reason: "enqueued",
  });
});

test("cancelled jobs retain failed-step evidence and cannot pass verified supersession", () => {
  const cases = [...FAST_DEPTH_EVENTS, EVENT.mergeGroup].flatMap((event) =>
    resultJob.needs.map((job) => ({ event, job })),
  );
  for (const { item, exitCode, stdout } of evaluateResults(
    cases,
    ({ event, job }) => ({
      event,
      results: { [activeJobForEvent(job, event)]: "cancelled" },
      cancellationEvidence: "superseded",
      embeddedStepFailure: true,
    }),
  )) {
    expect(exitCode, `${item.event}/${item.job}`).toBe(1);
    expect(stdout).toContain("Cancelled CI job contains a failed step:");
    expect(stdout).toContain("3: Validate contract");
  }
  const options = {
    event: EVENT.pullRequest,
    results: { "ci-tests": "cancelled" },
    cancellationEvidence: "superseded",
    embeddedStepFailure: true,
  } as const;
  const outcomeScript = resultStep.run.replace(
    'if [[ -n "$failed_steps" ]]; then',
    "if false; then",
  );
  expect(outcomeScript).not.toBe(resultStep.run);
  expect(evaluateResult({ ...options, outcomeScript })).toBe(0);
  // Runs the outcome script for every required job of three events.
}, 30_000);

test("ci-result summary opens with the failed job and step before its cancelled verdict", () => {
  const outcomeScript = `
GITHUB_STEP_SUMMARY=$(mktemp)
set +e
(
set -e
${resultStep.run}
)
status=$?
printf "\\nRECORDED_SUMMARY\\n"; cat "$GITHUB_STEP_SUMMARY"; rm "$GITHUB_STEP_SUMMARY"
exit "$status"`;
  const result = onlyOutcome(
    evaluateResults([EVENT.mergeGroup], (event) => ({
      event,
      results: { "ci-tests": "cancelled" },
      cancellationEvidence: "missing",
      embeddedStepFailure: true,
      outcomeScript,
    })),
  );
  expect(result.exitCode).toBe(1);
  const summary = result.stdout.split("RECORDED_SUMMARY\n").at(1);
  expect(summary).toMatch(
    /^Merge group failed: .+ \/ 3: Validate contract \(https:\/\/example\.test\/jobs\/10\)\. Other jobs were cancelled to free runners\.\n$/u,
  );
  expect(result.stdout.split("RECORDED_SUMMARY").at(0)).toContain(
    summary?.trim() ?? "missing summary",
  );
});

test("cancelled dependencies fail closed on API errors, missing jobs and mixed matrix causes", () => {
  const cancelled = {
    event: EVENT.pullRequest,
    results: { "ci-tests": "cancelled" },
    cancellationEvidence: "superseded",
  } as const;
  for (const apiFailure of [
    "current-run",
    "runs",
    "jobs",
    "annotations",
  ] as const) {
    expect(evaluateResult({ ...cancelled, apiFailure })).toBe(1);
  }
  expect(evaluateResult({ ...cancelled, missingJob: true })).toBe(1);
  expect(evaluateResult({ ...cancelled, matrixTimeoutSibling: true })).toBe(1);
});

test("supersession needs a newer run of the same workflow and concurrency group", () => {
  for (const event of FAST_DEPTH_EVENTS) {
    for (const newerRun of [
      "none",
      "other-workflow",
      "other-event",
      "older",
    ] as const) {
      expect(
        evaluateResult({
          event,
          suiteDepth: SUITE_DEPTH.fast,
          results: { "ci-tests": "cancelled" },
          cancellationEvidence: "missing",
          newerRun,
        }),
      ).toBe(1);
    }
    const otherGroup = event === EVENT.pullRequest ? "other-pr" : "other-ref";
    expect(
      evaluateResult({
        event,
        suiteDepth: SUITE_DEPTH.fast,
        results: { "ci-tests": "cancelled" },
        newerRun: otherGroup,
      }),
    ).toBe(1);
    expect(
      evaluateResult({
        event,
        suiteDepth: SUITE_DEPTH.fast,
        results: { "ci-tests": "cancelled" },
        cancellationEvidence: "missing",
        newerRun: "same-time",
      }),
    ).toBe(0);
  }
});

test("queued cancelled jobs need no annotations or check run when supersession is proved", () => {
  expect(queuedJob.steps).toHaveLength(0);
  expect(queuedJob.annotations.flat()).toHaveLength(0);
  for (const queuedCancellation of ["with-check", "without-check"] as const) {
    expect(
      evaluateResult({
        event: EVENT.workflowDispatch,
        suiteDepth: SUITE_DEPTH.fast,
        results: { "e2e-production-shard": "cancelled" },
        cancellationEvidence: "missing",
        queuedCancellation,
      }),
    ).toBe(0);
    expect(
      evaluateResult({
        event: EVENT.workflowDispatch,
        suiteDepth: SUITE_DEPTH.fast,
        results: { "e2e-production-shard": "cancelled" },
        cancellationEvidence: "missing",
        queuedCancellation,
        newerRun: "none",
      }),
    ).toBe(1);
    expect(
      evaluateResult({
        event: EVENT.workflowDispatch,
        suiteDepth: SUITE_DEPTH.fast,
        results: {
          "ci-tests": "cancelled",
          "e2e-production-shard": "cancelled",
        },
        queuedCancellation,
        matrixTimeoutSibling: true,
      }),
    ).toBe(1);
  }
});

test("a failed dependency stays red beside a cancelled sibling even during supersession", () => {
  for (const event of FAST_DEPTH_EVENTS) {
    for (const cancellationEvidence of ["timeout", "superseded"] as const) {
      expect(
        evaluateResult({
          event,
          results: { "ci-tests": "cancelled", "code-quality-api": "failure" },
          suiteDepth: SUITE_DEPTH.fast,
          cancellationEvidence,
        }),
      ).toBe(1);
    }
  }
});

test("only a pull request or a manual run skips heavy suites or passes a superseded run", () => {
  expect(heavyJobs.length).toBeGreaterThan(0);
  const skippedHeavy = Object.fromEntries(
    heavyJobs.map((job) => [job, "skipped"]),
  );
  const unplannedHeavyScopes = heavyJobs.flatMap((job) => {
    const scope = fastJobScopes[job] ?? jobScopes[job];
    return typeof scope === "string" ? [scope] : [];
  });
  const fast = SUITE_DEPTH.fast;
  for (const event of FAST_DEPTH_EVENTS) {
    expect(
      evaluateResult({
        event,
        results: skippedHeavy,
        suiteDepth: fast,
        unplannedScopes: unplannedHeavyScopes,
      }),
      event,
    ).toBe(0);
    expect(
      evaluateResult({
        event,
        results: { "ci-tests": "cancelled" },
        suiteDepth: fast,
        cancellationEvidence: "superseded",
      }),
      event,
    ).toBe(0);
    // A timed-out sibling reads as cancelled; the failure still stands.
    expect(
      evaluateResult({
        event,
        results: { "ci-tests": "cancelled", "code-quality-api": "failure" },
        suiteDepth: fast,
      }),
      event,
    ).toBe(1);
    expect(
      evaluateResult({
        event,
        results: { "ci-plan": "cancelled" },
        suiteDepth: fast,
        cancellationEvidence: "superseded",
      }),
      event,
    ).toBe(0);
    expect(
      evaluateResult({ event, results: {}, suiteDepth: "" }),
      `${event} at no depth`,
    ).toBe(1);
  }
  // A manual full run holds the heavy suites to the merge queue's bar.
  expect(
    evaluateResult({
      event: EVENT.workflowDispatch,
      results: skippedHeavy,
      suiteDepth: SUITE_DEPTH.full,
    }),
  ).toBe(1);
  const event = EVENT.mergeGroup;
  expect(evaluateResult({ event, results: {} })).toBe(0);
  expect(evaluateResult({ event, results: skippedHeavy })).toBe(1);
  expect(evaluateResult({ event, results: { "ci-plan": "cancelled" } })).toBe(
    1,
  );
  for (const suiteDepth of [SUITE_DEPTH.fast, ""] as const) {
    expect(
      evaluateResult({ event, results: {}, suiteDepth }),
      `${event} at depth '${suiteDepth}'`,
    ).toBe(1);
  }
});

test("a skipped plan passes only while the pull request is still a draft", () => {
  const skippedPlan = Object.fromEntries(
    resultJob.needs.map((job) => [job, "skipped"]),
  );
  const event = EVENT.pullRequest;
  // A push to a draft runs nothing, and nothing has to.
  expect(
    evaluateResult({
      event,
      results: skippedPlan,
      suiteDepth: "",
      liveDraft: true,
    }),
  ).toBe(0);

  // A push to a draft, then marking it ready at once: the draft run's
  // payload still says draft and its plan skips. It must not certify a ready
  // pull request unchecked, and since re-running it replays the draft event,
  // it points at a fresh run instead of a re-run.
  const staleDraftOptions: EvaluateResultOptions = {
    event,
    results: skippedPlan,
    suiteDepth: "",
    liveDraft: false,
  };
  const staleDraft = onlyOutcome(
    evaluateResults([staleDraftOptions], (item) => item),
  );
  expect(staleDraft.exitCode).toBe(1);
  expect(staleDraft.stdout).toContain("Re-running this run cannot start CI");
  expect(staleDraft.stdout).toContain("push a commit");
  expect(staleDraft.stdout).not.toContain("re-run CI Checks");

  // An unanswered lookup is not a draft either.
  expect(evaluateResult({ event, results: skippedPlan, suiteDepth: "" })).toBe(
    1,
  );

  // Only a pull request can be a draft.
  for (const other of FULL_DEPTH_EVENTS) {
    expect(
      evaluateResult({
        event: other,
        results: skippedPlan,
        suiteDepth: "",
        liveDraft: true,
      }),
      other,
    ).toBe(1);
  }
});

const fastRequired = v.parse(
  v.array(v.string()),
  JSON.parse(resultStep.env["FAST_REQUIRED"] ?? ""),
);

test("a planned release screenshot check certifies the merge group", () => {
  // The planner selects it only for release pull requests and tags, so a
  // full-depth gate would skip it on the pull request every time.
  expect(jobIf(ciJobs["marketing-screenshots"])).toContain(
    "needs.ci-plan.outputs.marketing_screenshots_required == 'true'",
  );
  expect(heavyJobs).toContain("marketing-screenshots");
  expect(fastRequired).not.toContain("marketing-screenshots");
  const event = EVENT.mergeGroup;
  expect(
    evaluateResult({ event, results: { "marketing-screenshots": "skipped" } }),
  ).toBe(1);
  expect(
    evaluateResult({
      event,
      results: { "marketing-screenshots": "skipped" },
      unplannedScopes: ["marketing_screenshots_required"],
    }),
  ).toBe(0);
});

test("path-scoped platform checks run in the merge group", () => {
  for (const job of ["desktop-rust-tests", "windows-scripts"]) {
    expect(fastRequired, job).not.toContain(job);
    expect(heavyJobs, job).toContain(job);
    expect(typeof jobScopes[job], job).toBe("string");
  }
});

test("Docker checks are required at every selected merge-group depth", () => {
  const job = "docker-checks";
  expect(mainHeavyJobs({ jobs: ciJobs })).toContain(job);
  expect(jobScopes[job]).toBe("docker_checks_required");
  expect(fastRequired).not.toContain(job);
  for (const queueDepth of ["thin", "full"] as const) {
    expect(
      runsAtDepth(jobIf(ciJobs[job]), {
        event: EVENT.mergeGroup,
        depth: SUITE_DEPTH.full,
        queueDepth,
      }),
    ).toBe(true);
  }
  expect(
    evaluateResult({ event: EVENT.mergeGroup, results: { [job]: "skipped" } }),
  ).toBe(1);
});

test("desktop Rust tests select classified merge-group changes at every queue depth", () => {
  const platforms = v.array(
    v.object({ os: v.string(), runner: v.string(), target: v.string() }),
  );
  const job = v.parse(
    v.object({
      strategy: v.object({ matrix: v.object({ include: platforms }) }),
    }),
    ciJobs["desktop-rust-tests"],
  );
  const lintPlatforms = v.parse(
    v.object({
      strategy: v.object({ matrix: v.object({ include: platforms }) }),
    }),
    ciJobs["desktop-rust-lint"],
  ).strategy.matrix.include;
  for (const event of [EVENT.mergeGroup, EVENT.pullRequest]) {
    for (const file of ["apps/desktop/src-tauri/src/lib.rs", "docs/guide.md"]) {
      const [required] = runSelector(
        [file],
        ["desktop_rust_checks_required"],
        "full",
        "false",
        event,
      );
      expect(required, file).toBe(String(file.endsWith(".rs")));
      for (const queueDepth of ["thin", "full"]) {
        for (const runRequired of ["true", "false"]) {
          const context = {
            values: {
              "github.event_name": event,
              "inputs.pr_depth_only": false,
              "needs.ci-plan.outputs.run_required": runRequired,
              "needs.ci-plan.outputs.queue_depth": queueDepth,
              // An unarmed pull request; a group without armed proof.
              "needs.ci-plan.outputs.heavy_proof": String(
                event === EVENT.mergeGroup && runRequired === "true",
              ),
              "needs.ci-plan.outputs.trusted": "true",
              "needs.ci-plan.outputs.desktop_rust_checks_required":
                required ?? "",
            },
            status: { cancelled: false },
          };
          expect(
            evaluate(jobIf(ciJobs["desktop-rust-tests"]), context),
            `${event}/${file}/${queueDepth}/${runRequired}`,
          ).toBe(
            event === EVENT.mergeGroup &&
              required === "true" &&
              runRequired === "true",
          );
          const selected = job.strategy.matrix.include;
          expect(selected.map(({ os }) => os)).toEqual(["macos", "windows"]);
          expect(selected).toEqual(lintPlatforms);
          expect(selected.at(0)).toEqual({
            os: "macos",
            runner: "macos-14",
            target: "aarch64-apple-darwin",
          });
          expect(selected.at(1)).toEqual({
            os: "windows",
            runner: "windows-latest",
            target: "x86_64-pc-windows-msvc",
          });
        }
      }
    }
  }
});

test("thin merge groups require planned desktop Rust tests to succeed", () => {
  const cases = ["true", "false"].flatMap((required) =>
    ["success", "skipped", "failure", "cancelled"].map((result) => ({
      required,
      result,
    })),
  );
  for (const { item, exitCode } of runBashBatch(
    cases,
    ({ required, result }) => {
      const base = resultGateCase({
        event: EVENT.mergeGroup,
        results: { "desktop-rust-tests": result },
        unplannedScopes:
          required === "false" ? ["desktop_rust_checks_required"] : [],
      });
      return {
        ...base,
        env: {
          ...base.env,
          QUEUE_DEPTH: "thin",
          THIN_JOBS: JSON.stringify(thinJobs({ jobs: ciJobs })),
          QUEUE_REQUIRED_JOBS: JSON.stringify(
            queueAdmittedJobs({ jobs: ciJobs }),
          ),
        },
      };
    },
  )) {
    const accepted =
      item.result === "success" ||
      (item.required === "false" && item.result === "skipped");
    expect(exitCode, `${item.required}/${item.result}`).toBe(accepted ? 0 : 1);
  }
});

test("desktop Rust lint is required on PRs and every merge-group depth", () => {
  const lint = "desktop-rust-lint";
  expect(fastRequired).toContain(lint);
  expect(thinJobs({ jobs: ciJobs })).toContain(lint);
  expect(jobScopes[lint]).toBe("desktop_rust_checks_required");
  for (const event of [EVENT.pullRequest, EVENT.mergeGroup]) {
    for (const queueDepth of ["thin", "full"] as const) {
      expect(
        runsAtDepth(jobIf(ciJobs[lint]), {
          event,
          depth:
            event === EVENT.pullRequest ? SUITE_DEPTH.fast : SUITE_DEPTH.full,
          queueDepth,
        }),
      ).toBe(true);
    }
    expect(evaluateResult({ event, results: { [lint]: "skipped" } })).toBe(1);
    expect(
      evaluateResult({
        event,
        results: { [lint]: "skipped" },
        unplannedScopes: ["desktop_rust_checks_required"],
      }),
    ).toBe(0);
  }
  const job = v.parse(
    v.object({
      strategy: v.object({
        matrix: v.object({ include: v.array(v.object({ os: v.string() })) }),
      }),
      steps: v.array(
        v.looseObject({
          run: v.optional(v.string()),
          if: v.optional(v.string()),
          env: v.optional(v.record(v.string(), v.unknown())),
        }),
      ),
    }),
    ciJobs[lint],
  );
  expect(job.strategy.matrix.include.map(({ os }) => os).toSorted()).toEqual([
    "macos",
    "windows",
  ]);
  const clippy = job.steps.find(({ run }) => run?.includes("cargo clippy"));
  expect(clippy?.run).toContain("--workspace --all-targets");
  expect(clippy?.run).toEndWith(" -- -D warnings");
  expect(clippy?.run && lockedOfflineCargo(clippy.run, clippy.env)).toBe(true);
  expect(clippy?.if).toBeUndefined();
});

// Cargo's own flags (before ` -- `) must pin the lockfile and keep cargo off
// the network: `--frozen`, or `--locked` with `--offline` or
// CARGO_NET_OFFLINE=true (inline or in the step env).
const lockedOfflineCargo = (
  run: string,
  env: Readonly<Record<string, unknown>> = {},
): boolean => {
  const [cargoPart = ""] = run.split(" -- ");
  const flags = new Set(cargoPart.split(/\s+/u));
  const stepOffline = env["CARGO_NET_OFFLINE"];
  const offlineEnv =
    stepOffline === true ||
    stepOffline === "true" ||
    /(?:^|\s)CARGO_NET_OFFLINE=["']?true["']?\s/u.test(cargoPart);
  return (
    flags.has("--frozen") ||
    (flags.has("--locked") && (flags.has("--offline") || offlineEnv))
  );
};

test("desktop Rust lint contract accepts only locked offline cargo", () => {
  const base = "cargo clippy --workspace --all-targets";
  expect(lockedOfflineCargo(`${base} --frozen -- -D warnings`)).toBe(true);
  expect(lockedOfflineCargo(`${base} --locked --offline -- -D warnings`)).toBe(
    true,
  );
  expect(
    lockedOfflineCargo(`${base} --locked -- -D warnings`, {
      CARGO_NET_OFFLINE: "true",
    }),
  ).toBe(true);
  expect(
    lockedOfflineCargo(
      `CARGO_NET_OFFLINE=true ${base} --locked -- -D warnings`,
    ),
  ).toBe(true);
  expect(lockedOfflineCargo(`${base} --locked -- -D warnings`)).toBe(false);
  expect(lockedOfflineCargo(`${base} --offline -- -D warnings`)).toBe(false);
  expect(
    lockedOfflineCargo(`${base} -- -D warnings`, { CARGO_NET_OFFLINE: "true" }),
  ).toBe(false);
  expect(lockedOfflineCargo(`${base} -- -D warnings --frozen`)).toBe(false);
});

test("every bounded-install implementation and fixture selects Windows", () => {
  const files = [...new Bun.Glob("scripts/ci-install*.ts").scanSync()];
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(runSelector([file], ["windows_scripts_required"]), file).toEqual([
      "true",
    ]);
  }
});

// timeout: Executes the complete selected-job matrix in real Bash processes.
test("a fast-depth run requires every selected fast-required job to run", () => {
  expect(fastRequired.length).toBeGreaterThan(0);
  const gates: ExpectedResultGate[] = [];
  for (const job of fastRequired) {
    expect(jobScopes).toHaveProperty(job);
    const scope = fastJobScopes[job] ?? jobScopes[job];
    // A scope-less job always runs; a scoped job must be selected by the plan.
    const event = EVENT.pullRequest;
    gates.push(
      {
        label: job,
        options: { event, results: { [job]: "success" } },
        exitCode: 0,
      },
      {
        label: job,
        options: { event, results: { [job]: "skipped" } },
        exitCode: 1,
      },
      {
        label: job,
        options: {
          event,
          results: { [job]: "cancelled" },
          cancellationEvidence: "superseded",
        },
        exitCode: 0,
      },
    );
    if (typeof scope === "string") {
      gates.push({
        label: job,
        options: {
          event,
          results: { [job]: "skipped" },
          unplannedScopes: [scope],
        },
        exitCode: 0,
      });
    }
  }
  // Any other planned job may still skip at fast depth.
  for (const job of gatedJobs.filter((name) => !fastRequired.includes(name))) {
    gates.push({
      label: job,
      options: { event: EVENT.pullRequest, results: { [job]: "skipped" } },
      exitCode: 0,
    });
  }
  expectResultGates(gates);
}, 30_000);

const MatrixJob = v.object({
  strategy: v.object({
    matrix: v.object({ include: v.array(MatrixEntry) }),
  }),
});

const jobSteps = (job: unknown) =>
  v.parse(
    v.object({
      steps: v.pipe(
        v.unknown(),
        v.transform((steps) => flattenWorkflowSteps(steps)),
        v.transform((steps) => steps.map(withoutStaticReuseCondition)),
        v.array(
          v.object({
            name: v.optional(v.string()),
            run: v.optional(v.string()),
            if: v.optional(v.string()),
            env: v.optional(v.record(v.string(), v.string())),
            "continue-on-error": v.optional(v.unknown()),
          }),
        ),
      ),
    }),
    job,
  ).steps;

const MATRIX_SHARD_ENV = `\${{ matrix.shard == 'rest-web' && 'rest' || matrix.shard }}`;

const missingFullTestShards = (source: string) => {
  const steps = jobSteps(workflowJobs(source)["full-test"]);
  return FULL_TEST_JOB_SHARDS.flatMap((jobShard) =>
    TEST_JOB_SHARDS[jobShard]
      .filter((suite: TestShardId) => {
        const matchingStep = steps.find((step) => {
          if (
            !step.run?.includes('scripts/test-shards.ts --filters "$SHARD"') ||
            !step.run.includes(
              `bun run test -- --concurrency=2 "\${shard_args[@]}"`,
            )
          ) {
            return false;
          }
          const configuredShard = step.env?.["SHARD"];
          let actualShard = configuredShard;
          if (configuredShard === MATRIX_SHARD_ENV) {
            actualShard = jobShard === "rest-web" ? "rest" : jobShard;
          }
          if (actualShard !== suite) {
            return false;
          }
          const gatedShard = /matrix\.shard == '(?<shard>[a-z0-9-]+)'/u.exec(
            step.if ?? "",
          )?.groups?.["shard"];
          return gatedShard === undefined || gatedShard === jobShard;
        });
        return matchingStep === undefined;
      })
      .map((suite: TestShardId) => [jobShard, suite].join("/")),
  );
};
test("UI playground scope covers the component directories rendered by its table bench", () => {
  const bench = readFileSync(
    new URL(
      "../apps/web/src/routes/dev/-components/workspace-table-playground.tsx",
      import.meta.url,
    ),
    "utf-8",
  );
  const tableModulePath =
    "../apps/web/src/features/case-law/components/decision-table.tsx";
  expect(bench).toContain(
    'from "@/features/case-law/components/decision-table"',
  );

  const tableModule = readFileSync(
    new URL(tableModulePath, import.meta.url),
    "utf-8",
  );
  const renderedComponentDirectories = new Set(
    [...tableModule.matchAll(/from "@\/(components\/.+)\/[^/"]+"/gu)].flatMap(
      ([, directory]) =>
        directory === undefined ? [] : [`apps/web/src/${directory}`],
    ),
  );
  expect(renderedComponentDirectories.size).toBeGreaterThan(0);

  const scopeStep = jobSteps(ciJobs["ci-browser"]).find(
    ({ name }) => name === "Check UI browser test scope",
  );
  expect(scopeStep?.run).toBeDefined();
  for (const directory of renderedComponentDirectories) {
    expect(scopeStep?.run, directory).toContain(`  ${directory} \\`);
  }
});

test("CI plan guards see checks nested inside parallel groups", () => {
  const guard = {
    name: "Nested check",
    run: "bun test scripts/ci-plan.test.ts",
    if: "!cancelled() && steps.install.outcome == 'success'",
    env: { CHECK_REQUIRED: "true" },
  };
  expect(jobSteps({ steps: [{ parallel: [{ parallel: [guard] }] }] })).toEqual([
    guard,
  ]);
});

type ResolveDepthOptions = {
  ref?: string;
  allowFull?: string;
  heavyOnly?: string;
};
const resolveDepth = (
  eventName: string,
  dispatchDepth: string,
  options: ResolveDepthOptions = {},
) => {
  const step = jobSteps(ciJobs["ci-plan"]).find(
    ({ name }) => name === "Resolve suite depth",
  );
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-plan-depth-"));
  const output = nodePath.join(directory, "output");
  writeFileSync(output, "");
  try {
    const run = Bun.spawnSync({
      cmd: ["bash", "-e", "-c", step?.run ?? "exit 1"],
      env: {
        DISPATCH_DEPTH: dispatchDepth,
        DISPATCH_REF: options.ref ?? "refs/heads/main",
        ALLOW_FULL: options.allowFull ?? "false",
        HEAVY_ONLY: options.heavyOnly ?? "false",
        EVENT_NAME: eventName,
        GITHUB_OUTPUT: output,
        PATH: process.env["PATH"] ?? "",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    return run.exitCode === 0 ? readFileSync(output, "utf-8").trim() : "error";
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const shellLocals = (script: string): Set<string> => {
  const withoutExpressions = script.replace(/\$\{\{[\s\S]*?\}\}/gu, "");
  const defined = new Set<string>();
  const declarations = /\b(?:local|declare|typeset|readonly)\s+([^\n;]+)/gu;
  for (const [, names] of withoutExpressions.matchAll(declarations)) {
    for (const [, name] of (names ?? "").matchAll(
      /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)(?==|\s|$)/gu,
    )) {
      if (name !== undefined) {
        defined.add(name);
      }
    }
  }
  for (const [, assignment, loop] of withoutExpressions.matchAll(
    /(?:^|[\s;]|\()([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)|\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/gu,
  )) {
    const name = assignment ?? loop;
    if (name !== undefined) {
      defined.add(name);
    }
  }
  for (const [, name] of withoutExpressions.matchAll(
    /\bread\b[^\n;]*?\s([A-Za-z_][A-Za-z0-9_]*)\s*(?:$|;)/gmu,
  )) {
    if (name !== undefined) {
      defined.add(name);
    }
  }
  return defined;
};

const shellVariableReads = (script: string): Set<string> => {
  const reads = new Set<string>();
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    if (character === "\\" && quote !== "single") {
      index += 1;
      continue;
    }
    if (quote === "single") {
      if (character === "'") {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" && quote === undefined) {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    if (
      character === "#" &&
      quote === undefined &&
      (index === 0 || /[\s;|&()]/u.test(script[index - 1] ?? ""))
    ) {
      const newline = script.indexOf("\n", index);
      index = newline === -1 ? script.length : newline;
      continue;
    }
    if (character !== "$" || script[index + 1] === "{") {
      if (character === "$" && script[index + 1] === "{") {
        const end = script.indexOf("}", index + 2);
        if (end !== -1) {
          const expansion = script.slice(index + 2, end);
          const match = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/u.exec(expansion);
          if (match?.[1] !== undefined && !/^:?[-+]/u.test(match[2] ?? "")) {
            reads.add(match[1]);
          }
          index = end;
        }
      }
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(script.slice(index + 1));
    if (match?.[0] !== undefined) {
      reads.add(match[0]);
      index += match[0].length;
    }
  }
  return reads;
};

test("CI shell steps using nounset define every variable they read", () => {
  const parsedWorkflow = v.parse(
    v.looseObject({
      env: v.optional(v.record(v.string(), v.unknown())),
      jobs: v.record(v.string(), v.unknown()),
    }),
    Bun.YAML.parse(workflow),
  );
  const runnerEnvironment = new Set([
    "CI",
    "GITHUB_ACTION",
    "GITHUB_ACTION_PATH",
    "GITHUB_ACTION_REPOSITORY",
    "GITHUB_ACTIONS",
    "GITHUB_ACTOR",
    "GITHUB_ACTOR_ID",
    "GITHUB_API_URL",
    "GITHUB_BASE_REF",
    "GITHUB_ENV",
    "GITHUB_EVENT_NAME",
    "GITHUB_EVENT_PATH",
    "GITHUB_GRAPHQL_URL",
    "GITHUB_HEAD_REF",
    "GITHUB_JOB",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_REF_PROTECTED",
    "GITHUB_REF_TYPE",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER",
    "GITHUB_RETENTION_DAYS",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_NUMBER",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_WORKFLOW",
    "GITHUB_WORKSPACE",
    "HOME",
    "ImageOS",
    "ImageVersion",
    "RUNNER_ARCH",
    "RUNNER_NAME",
    "RUNNER_OS",
    "RUNNER_TEMP",
    "RUNNER_TOOL_CACHE",
    "BASH_REMATCH",
    "BASH_SOURCE",
    "BASH_VERSION",
    "BASHOPTS",
    "BASHPID",
    "EUID",
    "FUNCNAME",
    "IFS",
    "OLDPWD",
    "PIPESTATUS",
    "PPID",
    "PWD",
    "SHELLOPTS",
    "UID",
  ]);
  const rawJob = parsedWorkflow.jobs["ci-plan"];
  if (rawJob === undefined) {
    throw new TypeError("Missing ci-plan job");
  }
  const job = v.parse(
    v.looseObject({
      env: v.optional(v.record(v.string(), v.unknown())),
      steps: v.optional(v.unknown()),
    }),
    rawJob,
  );
  const jobEnvironment = new Set([
    ...Object.keys(parsedWorkflow.env ?? {}),
    ...Object.keys(job.env ?? {}),
  ]);
  const failures = flattenWorkflowSteps(job.steps ?? []).flatMap((step) => {
    if (
      typeof step["run"] !== "string" ||
      !/\bset\s+-[^\n]*u/u.test(step["run"])
    ) {
      return [];
    }
    const stepDetails = v.parse(
      v.looseObject({
        name: v.optional(v.string()),
        env: v.optional(v.record(v.string(), v.unknown())),
        run: v.string(),
      }),
      step,
    );
    const defined = new Set([
      ...runnerEnvironment,
      ...jobEnvironment,
      ...Object.keys(stepDetails.env ?? {}),
      ...shellLocals(stepDetails.run),
    ]);
    const shell = stepDetails.run.replace(/\$\{\{[\s\S]*?\}\}/gu, "");
    const missing = [...shellVariableReads(shell)]
      .filter((name) => !defined.has(name))
      .toSorted(compareCodeUnit);
    return missing.length > 0
      ? [`ci-plan/${stepDetails.name ?? "unnamed step"}: ${missing.join(", ")}`]
      : [];
  });
  expect(failures).toEqual([]);
});

test("a manual run supersedes only an older manual run on the same branch", () => {
  const concurrency = v.parse(
    v.object({
      concurrency: v.object({
        group: v.string(),
        "cancel-in-progress": v.string(),
      }),
    }),
    Bun.YAML.parse(workflow),
  ).concurrency;
  expect(concurrency["cancel-in-progress"]).toBe(
    `\${{ (github.event_name == 'push' && github.ref == 'refs/heads/main') || (inputs.heavy_only != true && ((github.event_name == 'pull_request' && (contains(fromJSON('["opened","synchronize","reopened","ready_for_review"]'), github.event.action) || github.event.label.name == 'prove-fix')) || github.event_name == 'workflow_dispatch')) }}`,
  );
  expect(concurrency.group).toContain(
    "github.event_name == 'workflow_dispatch' && format('ci-dispatch-{0}', github.ref)",
  );
  // A draft run has its own group: queued after the ready run of the same
  // head, it would otherwise cancel the only run that can prove it.
  expect(concurrency.group).toContain(
    "format('pr-{0}{1}', github.event.pull_request.number || github.ref, github.event.pull_request.draft && '-draft' || '')",
  );
  expect(concurrency.group).toContain("format('run-{0}', github.run_id)");
});

test("jobs that need ci-plan never hand its outputs over in the environment", () => {
  // One environment or input value above Linux's 128 KiB limit stops a step
  // before it starts, and ci-plan's change lists and test plans exceed it.
  // Such jobs read `needs` from their script text instead.
  const stepSchema = v.looseObject({
    name: v.optional(v.string()),
    env: v.optional(v.record(v.string(), v.unknown())),
    with: v.optional(v.record(v.string(), v.unknown())),
  });
  const unbounded = /toJSON\(\s*needs\s*(?:\.\s*ci-plan\s*\.\s*outputs\s*)?\)/u;
  const offenders = Object.entries(ciJobs).flatMap(([name, job]) => {
    const parsed = v.parse(
      v.looseObject({
        needs: v.optional(v.union([v.string(), v.array(v.string())])),
        env: v.optional(v.record(v.string(), v.unknown())),
        steps: v.optional(v.array(v.unknown())),
      }),
      job,
    );
    if (![parsed.needs ?? []].flat().includes("ci-plan")) {
      return [];
    }
    const steps = flattenWorkflowSteps(parsed.steps ?? []).map((step) =>
      v.parse(stepSchema, step),
    );
    return [
      ...Object.entries(parsed.env ?? {}).map(([key, value]) => ({
        where: `${name}/env`,
        key,
        value,
      })),
      ...steps.flatMap((step) =>
        Object.entries({ ...step.env, ...step.with }).map(([key, value]) => ({
          where: `${name}/${step.name ?? "unnamed step"}`,
          key,
          value,
        })),
      ),
    ]
      .filter(({ value }) => typeof value === "string" && unbounded.test(value))
      .map(({ where, key }) => `${where}: ${key}`);
  });
  expect(offenders).toEqual([]);
});

test("ci-result's outcome step reads its inputs from the step written right before it", () => {
  // The harness runs RESULT_INPUTS_RUN before the outcome script, so the
  // workflow must declare exactly that script, immediately before it.
  const declared = resultInputsSteps.map((step) =>
    v.parse(v.strictObject({ name: v.string(), run: v.string() }), step),
  );
  expect(declared.length).toBe(1);
  expect(declared.at(0)?.run).toBe(RESULT_INPUTS_RUN);
  expect(resultJob.steps.indexOf(evaluationSteps.at(0))).toBe(
    resultInputsStepIndex + 1,
  );
  expect(embedsExpression(resultStep.run)).toBe(false);
});

test("no workflow string that embeds an expression exceeds GitHub's expression limit", async () => {
  // GitHub evaluates a string embedding an expression as one expression and
  // refuses the whole workflow file when one exceeds the limit, so no
  // pull_request run starts at all.
  const directory = new URL("../.github/workflows/", import.meta.url);
  const offenders: string[] = [];
  const visit = (value: unknown, where: string) => {
    if (typeof value === "string") {
      if (embedsExpression(value) && value.length > GITHUB_EXPRESSION_LIMIT) {
        offenders.push(`${where} (${value.length} characters)`);
      }
    } else if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        visit(item, `${where}[${index}]`);
      }
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        visit(item, `${where}.${key}`);
      }
    }
  };
  for (const file of new Bun.Glob("*.{yml,yaml}").scanSync(
    directory.pathname,
  )) {
    visit(
      Bun.YAML.parse(await Bun.file(new URL(file, directory)).text()),
      file,
    );
  }
  expect(offenders).toEqual([]);
});

test("metadata runs report the required result while scope-changing labels still run", () => {
  const plan = v.parse(
    v.object({
      outputs: v.record(v.string(), v.string()),
      steps: v.array(v.unknown()),
    }),
    ciJobs["ci-plan"],
  );
  const result = v.parse(
    v.object({ name: v.string(), if: v.string() }),
    ciJobs["ci-result"],
  );
  expect(result.if).toBe("always()");
  expect(result.name).toBe("ci-result");
  expect(plan.outputs["metadata_only"]).toBe(
    `\${{ steps.completed-depth.outputs.metadata_only }}`,
  );

  const completedDepth = flattenWorkflowSteps(plan.steps).find(
    (step) => step["name"] === "Check completed suite depth",
  );
  const script = v.parse(
    v.object({ with: v.object({ script: v.string() }) }),
    completedDepth,
  ).with.script;
  // prove-fix and the armed label change suite scope; ready_for_review
  // starts the first code run of a draft and auto_merge_enabled starts the
  // armed suites: none is metadata, so all report ci-result.
  expect(script).toContain(
    '["prove-fix", ARMED_LABEL].includes(context.payload.label?.name)',
  );
  expect(script).toContain(
    '&& ["labeled", "unlabeled"].includes(context.payload.action)\n  && !scopeLabel;',
  );
  expect(script).toContain("if (mirrorsCodeRun) {");
  expect(script).not.toMatch(/"enqueued", "ready_for_review"\]\.includes/u);
  expect(script).toContain('core.setOutput("run_required", "false")');
});

test("a metadata run without an earlier code run of its head runs the suites", async () => {
  const completedDepth = flattenWorkflowSteps(
    v.parse(v.object({ steps: v.array(v.unknown()) }), ciJobs["ci-plan"]).steps,
  ).find((step) => step["name"] === "Check completed suite depth");
  const script = new Script(
    `(async () => {${
      v.parse(
        v.object({ with: v.object({ script: v.string() }) }),
        completedDepth,
      ).with.script
    }\n})()`,
  );
  const head = "a".repeat(40);
  const run = (id: number, overrides: Record<string, unknown> = {}) => ({
    id,
    head_sha: head,
    status: "completed",
    conclusion: "success",
    pull_requests: [{ number: 7 }],
    ...overrides,
  });
  const plan = (name: string) => [{ name }, { name: "ci-result" }];
  const cases = [
    { name: "no earlier run", runs: [], jobs: {}, mirrors: false },
    {
      name: "earlier code run",
      runs: [run(10)],
      jobs: { 10: plan("ci-plan") },
      mirrors: true,
    },
    {
      name: "code run in flight",
      runs: [run(10, { status: "queued", conclusion: null })],
      jobs: {},
      mirrors: true,
    },
    {
      name: "only metadata runs",
      runs: [run(10)],
      jobs: { 10: plan("ci-metadata-plan") },
      mirrors: false,
    },
    {
      name: "cancelled code run",
      runs: [run(10, { conclusion: "cancelled" })],
      jobs: { 10: plan("ci-plan") },
      mirrors: false,
    },
    {
      name: "later code run",
      runs: [run(600)],
      jobs: { 600: plan("ci-plan") },
      mirrors: false,
    },
    {
      name: "other pull request",
      runs: [run(10, { pull_requests: [{ number: 8 }] })],
      jobs: { 10: plan("ci-plan") },
      mirrors: false,
    },
    { name: "lookup failure", runs: undefined, jobs: {}, mirrors: false },
  ] as const;
  for (const { name, runs, jobs, mirrors } of cases) {
    const outputs: Record<string, string> = {};
    const listWorkflowRuns = () => {};
    const listJobsForWorkflowRun = () => {};
    await script.runInNewContext({
      require: (module: string) =>
        module === "node:crypto"
          ? import.meta.require("node:crypto")
          : panic(module),
      process: { env: { SUITE_DEPTH: "fast" } },
      Buffer,
      core: {
        info: () => {},
        setOutput: (key: string, value: string) => {
          outputs[key] = value;
        },
      },
      context: {
        eventName: "pull_request",
        runId: 500,
        repo: { owner: "stella", repo: "stella" },
        payload: {
          action: "labeled",
          label: { name: "ready" },
          pull_request: {
            number: 7,
            title: "fix: something",
            body: "",
            labels: [],
            head: { sha: head, repo: { id: 1 } },
            base: { sha: "b".repeat(40) },
          },
        },
      },
      github: {
        paginate: async (
          method: unknown,
          request: { run_id?: number },
        ): Promise<unknown[]> => {
          if (method === listWorkflowRuns) {
            if (runs === undefined) {
              throw new Error("unavailable");
            }
            return [...runs];
          }
          if (method === listJobsForWorkflowRun) {
            return [...(Reflect.get(jobs, request.run_id ?? 0) ?? [])];
          }
          return panic("unexpected paginate");
        },
        rest: {
          actions: {
            listWorkflowRuns,
            listJobsForWorkflowRun,
            listArtifactsForRepo: async () => ({ data: { artifacts: [] } }),
          },
        },
      },
    });
    expect(outputs["metadata_only"], name).toBe(mirrors ? "true" : undefined);
    expect(outputs["run_required"], name).toBe(mirrors ? "false" : "true");
  }
});

test("metadata ci-result mirrors only a code run on the same pull request head", () => {
  const immediateCases = [
    {
      state: "green",
      exitCode: 0,
      message: "evaluated every required job of head",
    },
    { state: "red", exitCode: 1, message: "(evaluated-failure)" },
    { state: "missing", exitCode: 1, message: "no code run exists" },
    { state: "other-head", exitCode: 1, message: "no code run exists" },
    {
      state: "completed-without-result",
      exitCode: 1,
      message: "completed without a ci-result job",
    },
  ] as const;
  for (const { state, exitCode, message } of immediateCases) {
    const outcome = onlyOutcome(
      evaluateResults([state], () => ({
        event: EVENT.pullRequest,
        results: {},
        metadataCodeRun: state,
      })),
    );
    expect(outcome.exitCode, state).toBe(exitCode);
    expect(`${outcome.stdout}\n${outcome.stderr}`, state).toContain(message);
  }

  // A code run that has not yet reported, at any stage GitHub lists it,
  // makes the mirror wait for its ci-result instead of failing.
  for (const state of [
    "running-green",
    "queued-green",
    "planned-green",
  ] as const) {
    const waitedThenGreen = onlyOutcome(
      evaluateResults([state], () => ({
        event: EVENT.pullRequest,
        results: {},
        metadataCodeRun: state,
        outcomeScript: resultStep.run.replace(
          "local poll_seconds=30 max_wait_seconds=2700",
          "local poll_seconds=0 max_wait_seconds=2700",
        ),
      })),
    );
    expect(waitedThenGreen.exitCode, state).toBe(0);
    expect(waitedThenGreen.stdout, state).toContain(
      "evaluated every required job of head",
    );
  }

  const timedOut = onlyOutcome(
    evaluateResults(["running"], () => ({
      event: EVENT.pullRequest,
      results: {},
      metadataCodeRun: "running",
      outcomeScript: resultStep.run.replace(
        "local poll_seconds=30 max_wait_seconds=2700",
        "local poll_seconds=0 max_wait_seconds=0",
      ),
    })),
  );
  expect(timedOut.exitCode).toBe(1);
  expect(`${timedOut.stdout}\n${timedOut.stderr}`).toContain(
    "timed out after 45 min waiting for a code run",
  );
}, 20_000);

test("required checks retain PR and merge-group coverage", async () => {
  const workflowSchema = v.object({
    on: v.record(v.string(), v.unknown()),
    jobs: v.record(v.string(), v.unknown()),
  });
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = await Promise.all(
    [...new Bun.Glob("*.yml").scanSync(directory.pathname)].map(async (file) =>
      v.parse(
        workflowSchema,
        Bun.YAML.parse(await Bun.file(new URL(file, directory)).text()),
      ),
    ),
  );
  // Each required check is defined by exactly one workflow, wherever it lives.
  for (const job of ["ci-result", "dependency-review", "verify-signatures"]) {
    const owners = workflows.filter((candidate) =>
      Object.hasOwn(candidate.jobs, job),
    );
    expect(owners).toHaveLength(1);
    const [owner] = owners;
    expect(owner?.on).toHaveProperty("merge_group");
    expect(
      Object.hasOwn(owner?.on ?? {}, "pull_request") ||
        Object.hasOwn(owner?.on ?? {}, "pull_request_target"),
    ).toBe(true);
  }
});

test("full feature-branch dispatch requires an explicit opt-in at planning time", () => {
  for (const heavyOnly of ["false", "true"]) {
    expect(
      resolveDepth(EVENT.workflowDispatch, "full", {
        ref: "refs/heads/feature",
        heavyOnly,
      }),
    ).toBe("error");
    expect(
      resolveDepth(EVENT.workflowDispatch, "full", {
        ref: "refs/heads/feature",
        allowFull: "true",
        heavyOnly,
      }),
    ).toBe("suite_depth=full");
    expect(resolveDepth(EVENT.workflowDispatch, "full", { heavyOnly })).toBe(
      "suite_depth=full",
    );
  }
  expect(
    resolveDepth(EVENT.workflowDispatch, "fast", { ref: "refs/heads/feature" }),
  ).toBe("suite_depth=fast");
  expect(
    resolveDepth(EVENT.mergeGroup, "full", { ref: "refs/heads/queue" }),
  ).toBe("suite_depth=full");
});

test("a manual run plans the depth it was dispatched with, the merge queue always full, a pull request always fast", () => {
  expect(resolveDepth(EVENT.workflowDispatch, "fast")).toBe("suite_depth=fast");
  expect(resolveDepth(EVENT.workflowDispatch, "full")).toBe("suite_depth=full");
  expect(resolveDepth(EVENT.workflowDispatch, "")).toBe("error");
  expect(resolveDepth(EVENT.workflowDispatch, "fast; full")).toBe("error");
  for (const dispatchDepth of ["", "fast"]) {
    expect(resolveDepth(EVENT.mergeGroup, dispatchDepth)).toBe(
      "suite_depth=full",
    );
  }
  // The heavy suites run once, in the merge queue; no label or input turns
  // them on for a pull request.
  for (const dispatchDepth of ["", "full"]) {
    expect(resolveDepth(EVENT.pullRequest, dispatchDepth)).toBe(
      "suite_depth=fast",
    );
  }
  expect(resolveDepth("push", "")).toBe("error");
});

test("the landing site is built once when its browser checks are planned", () => {
  const withE2e = "apps/landing/src/pages/index.astro";
  const withoutE2e = "docs/changelog/entry.md";
  expect(runSelector([withE2e], ["e2e_landing_required"])).toEqual(["true"]);
  expect(runSelector([withoutE2e], ["e2e_landing_required"])).toEqual([
    "false",
  ]);
  const landingBuild = (suiteDepth: string, e2eLandingRequired: string) =>
    runSelector(
      [withoutE2e],
      ["landing_build_required"],
      suiteDepth,
      e2eLandingRequired,
    ).at(0);
  // e2e-landing runs at every depth and builds the site itself.
  expect(landingBuild("full", "true")).toBe("false");
  expect(landingBuild("full", "false")).toBe("true");
  expect(landingBuild("fast", "true")).toBe("false");
  expect(landingBuild("fast", "false")).toBe("true");
  expect(ciJobs["e2e-landing"]).toBeDefined();
  expect(jobSteps(ciJobs["e2e-landing"]).map(({ run }) => run)).toContain(
    jobSteps(ciJobs["landing-build"]).find(
      ({ name }) => name === "Build landing",
    )?.run,
  );
  // A landing change is checked in its own pull request and merge group,
  // not only by the scheduled full run.
  expect(jobIf(ciJobs["e2e-landing"])).not.toContain(FULL_DEPTH_PREDICATE);
  expect(jobIf(ciJobs["e2e-landing"])).toContain(
    "(github.event_name != 'pull_request' || needs.pr-heavy-gate.result == 'success')",
  );
  const { outputs } = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  expect(outputs["pr_heavy_gate_required"]).toContain(
    "steps.changed-files.outputs.e2e_landing_required == 'true'",
  );
});

test("ci-checks gates each generated-output guard on its planned scope", () => {
  const steps = v.parse(
    v.object({
      steps: v.array(
        v.object({ name: v.optional(v.string()), if: v.optional(v.string()) }),
      ),
    }),
    ciJobs["ci-checks-generated"],
  ).steps;
  for (const [name, scope] of [
    ["Web API types determinism guard", "web_api_types_required"],
    ["Route tree drift guard", "route_tree_required"],
    ["Workspace package export map guard", "published_exports_required"],
  ] as const) {
    const condition = steps.find((step) => step.name === name)?.if ?? "";
    expect(condition, name).toContain(
      `needs.ci-plan.outputs.${scope} == 'true'`,
    );
    expect(condition, name).toContain(
      "needs.ci-plan.outputs.package_checks_required == 'true'",
    );
  }
});

test("API determinism runs only after installation for its selected scope", () => {
  const condition = jobSteps(ciJobs["ci-checks-generated"]).find(
    ({ name }) => name === "Web API types determinism guard",
  )?.if;
  if (condition === undefined) {
    panic("Missing API determinism guard");
  }
  for (const cancelled of [false, true]) {
    for (const install of ["success", "failure", "skipped"]) {
      for (const packageChecks of [false, true]) {
        for (const apiTypes of [false, true]) {
          expect(
            evaluate(condition, {
              status: { cancelled },
              values: {
                "steps.install.outcome": install,
                "needs.ci-plan.outputs.package_checks_required":
                  String(packageChecks),
                "needs.ci-plan.outputs.web_api_types_required":
                  String(apiTypes),
              },
            }),
          ).toBe(
            !cancelled && install === "success" && packageChecks && apiTypes,
          );
        }
      }
    }
  }
});

const packageChecksPlan = (files: readonly string[]) =>
  String(requiresPackageChecks({ changed: files }));

test("transfer read guard runs for API-only pull request changes", () => {
  const guard = jobSteps(ciJobs["ci-checks-rest"]).find(
    ({ name }) => name === "Transfer timeout and fixed read guard",
  );
  expect(guard?.if).toContain("steps.install.outcome == 'success'");
  expect(guard?.if).toContain(
    "(needs.ci-plan.outputs.package_checks_required == 'true')",
  );
  expect(guard?.run).toContain("scripts/transfer-read-guard.test.ts");
  expect(guard?.run).toContain("bun scripts/transfer-read-guard.ts");
  expect(packageChecksPlan(["apps/api/src/handlers/files/get.ts"])).toBe(
    "true",
  );
  expect(jobScopes["ci-checks-rest"]).toBe("package_checks_required");
  expect(fastRequired).toContain("ci-checks-rest");
});

// Two workflow runs prove the scope hands its changed files to the detector
// and reads both answers; every case is classified in process, because a
// spawned detector is a cold Bun start that runs for seconds under CI load.
test("CLI packaging parity runs whenever CLI sources, codegen or generated outputs change", () => {
  const parity = Object.entries(ciJobs).flatMap(([job, body]) =>
    (v.is(v.object({ steps: v.array(v.unknown()) }), body)
      ? jobSteps(body)
      : []
    )
      .filter(({ run }) => run?.includes("scripts/cli-runtime-pack.test.ts"))
      .map(({ name, if: condition }) => ({ job, name, condition })),
  );
  expect(parity.map(({ job, name }) => `${job}: ${String(name)}`)).toEqual([
    "ci-checks-rest: Test CLI runtime package parity",
  ]);
  expect(parity.at(0)?.condition).toBe(
    `\${{ !cancelled() && steps.install.outcome == 'success' && (needs.ci-plan.outputs.package_checks_required == 'true') }}`,
  );
  expect(jobScopes["ci-checks-rest"]).toBe("package_checks_required");
  // A skipped fast-required job fails the result: the fast-depth test proves
  // that for every fast-required job, this one included.
  expect(fastRequired).toContain("ci-checks-rest");

  const generators = GENERATORS.filter(({ id }) =>
    ["cli-registry", "cli-runtime"].includes(id),
  );
  expect(generators).toHaveLength(2);
  const cliPaths = [
    ...generators.flatMap(({ inputs }) => inputs),
    ...generators.flatMap(({ outputs }) => outputs),
    "packages/cli/src/cli.ts",
    "packages/cli/src/codegen-version.ts",
    "scripts/generated-files.ts",
    "scripts/generated-imports.ts",
    "scripts/cli-runtime-pack.test.ts",
  ].map((glob) =>
    glob.replaceAll("**", "example/generated.ts").replaceAll("*", "example"),
  );
  // Ordinary documentation still skips package checks, through the workflow.
  expect(packageChecksPlan(["README.md"])).toBe("false");
  // A CLI source still requires them through the workflow.
  expect(packageChecksPlan(["packages/cli/src/cli.ts"])).toBe("true");
  // Every CLI path, alone and on either side of provenance files.
  const provenance = [".provenance.yml", "provenance/attestation.json"];
  for (const cliPath of cliPaths) {
    for (const files of [
      [cliPath],
      [cliPath, ...provenance],
      [...provenance, cliPath],
    ]) {
      expect(requiresPackageChecks({ changed: files }), files.join(" ")).toBe(
        true,
      );
    }
  }
});

const smokeCommands = (job: unknown) =>
  jobSteps(job).flatMap(({ run }) =>
    (run ?? "")
      .split("\n")
      .filter((line) => line.includes("scripts/smoke-api-image.sh"))
      .map((line) => line.replace(/^run: /u, "").trim()),
  );

const apiImageJob = ciJobs["api-image-smoke"];

test("CI rehearses every released API platform with the shared release smoke contract", () => {
  const releasePlatforms = v
    .parse(MatrixJob, releaseJobs["build"])
    .strategy.matrix.include.map(({ runner, platform }) => ({
      runner,
      platform,
    }))
    .toSorted((a, b) => compareCodeUnit(a.platform, b.platform));
  expect(releasePlatforms.length).toBeGreaterThan(0);
  expect(
    v.parse(
      v.object({
        strategy: v.object({ matrix: v.object({ include: v.string() }) }),
      }),
      apiImageJob,
    ).strategy.matrix.include,
  ).toBe(
    ["$", "{{ fromJSON(needs.ci-plan.outputs.api_image_platforms) }}"].join(""),
  );
  const fullDepthPlatforms = v.parse(
    v.array(MatrixEntry),
    JSON.parse(
      runSelector(["docs/x.md"], ["api_image_platforms"], "full").at(0) ?? "",
    ),
  );
  // workflow_dispatch plans every scope.
  const dispatchPlatforms = runSelector(
    [],
    ["api_image_platforms"],
    "full",
    "false",
    EVENT.workflowDispatch,
  ).at(0);
  for (const platforms of [
    fullDepthPlatforms,
    v.parse(v.array(MatrixEntry), JSON.parse(dispatchPlatforms ?? "")),
  ]) {
    expect(
      platforms.toSorted((a, b) => compareCodeUnit(a.platform, b.platform)),
    ).toEqual(releasePlatforms);
  }
  const ciCommands = smokeCommands(apiImageJob);
  const releaseCommands = Object.values(releaseJobs).flatMap(smokeCommands);
  expect(ciCommands).toHaveLength(1);
  expect(releaseCommands).toHaveLength(1);
  for (const command of [...ciCommands, ...releaseCommands]) {
    expect(command).toMatch(
      /^bash scripts\/smoke-api-image\.sh \S+(?: 2>&1 \| tee "\$RUNNER_TEMP\/[\w.-]+")?$/u,
    );
  }
});

test("an API image step that tees its log keeps the command's exit status", () => {
  const teed = jobSteps(apiImageJob).flatMap(({ run }) =>
    run?.includes("| tee ") ? [run] : [],
  );
  expect(teed).toHaveLength(2);
  for (const run of teed) {
    expect(run.trimStart()).toStartWith("set -euo pipefail\n");
  }
});

const annotateStep = jobSteps(apiImageJob).find(
  ({ name }) => name === "Annotate image failure",
);

const annotate = (logs: { build?: string; smoke?: string }) => {
  const runnerTemp = mkdtempSync(nodePath.join(tmpdir(), "ci-plan-annotate-"));
  try {
    if (logs.build !== undefined) {
      writeFileSync(
        nodePath.join(runnerTemp, "api-image-build.log"),
        logs.build,
      );
    }
    if (logs.smoke !== undefined) {
      writeFileSync(
        nodePath.join(runnerTemp, "api-image-smoke.log"),
        logs.smoke,
      );
    }
    const run = Bun.spawnSync({
      cmd: ["bash", "-e", "-c", annotateStep?.run ?? "exit 1"],
      env: {
        PATH: process.env["PATH"] ?? "",
        PLATFORM: "linux/arm64",
        RUNNER_TEMP: runnerTemp,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    return new TextDecoder().decode(run.stdout).trimEnd().split("\n");
  } finally {
    rmSync(runnerTemp, { force: true, recursive: true });
  }
};

test("a failed API image run annotates the failing lines, escaped", () => {
  expect(
    annotate({
      build: [
        "#13 120.001 ::error title=install-stall::kind=infra class=install-stall restore=cold idle_ms=120000",
        "#13 120.002 Install finished; exit 1; signal SIGKILL",
        "#13 ERROR: process did not complete successfully: exit code: 1",
      ].join("\n"),
    }),
  ).toEqual([
    "::error title=infra-stall::kind=infra class=install-stall restore=cold idle_ms=120000",
  ]);
  expect(
    annotate({
      smoke: [
        "PASS: fresh database migrations",
        "FAIL: /app/backfill.js did not reach 100% of validation\r::warning::x",
        "Cannot find module",
      ].join("\n"),
    }),
  ).toEqual([
    "::error title=API image smoke (linux/arm64)::FAIL: /app/backfill.js did not reach 100%25 of validation%0D::warning::x",
  ]);
  expect(
    annotate({ smoke: "PASS: fresh database migrations\nno ready\n" }),
  ).toEqual([
    "::error title=API image smoke (linux/arm64)::Failed after: PASS: fresh database migrations",
  ]);
  expect(annotate({ smoke: `FAIL: ${"x".repeat(900)}` })).toEqual([
    `::error title=API image smoke (linux/arm64)::FAIL: ${"x".repeat(494)}`,
  ]);
  expect(
    annotate({
      build: [
        "#10 [builder 3/40] RUN bun install",
        "#10 0.512 error: an earlier step that recovered",
        "#10 DONE 1.3s",
        "#45 [runtime-asset-smoke 2/2] RUN /tmp/image-smoke",
        "#45 0.312 image-smoke ok: quickjs sandbox wasm",
        "#45 0.402 Panic: no YARA rule files were compiled",
        "#45 ERROR: process did not complete successfully: exit code: 1",
        "ERROR: failed to solve: exit code: 1",
      ].join("\n"),
    }),
  ).toEqual([
    "::error title=API image build (linux/arm64)::Panic: no YARA rule files were compiled",
    "::error title=API image build (linux/arm64)::ERROR: process did not complete successfully: exit code: 1",
  ]);
  // Bun's uncaught-error report: the headline sits under a caret line.
  expect(
    annotate({
      build: [
        "#76 [runtime-asset-smoke 2/2] RUN /tmp/image-smoke",
        '#76 0.106 1 | (function (opts) {"use strict";',
        "#76 0.106               ^",
        "#76 0.106 ENOENT: no such file or directory, open '/app/yara'",
        '#76 0.106     path: "/app/yara",',
        "#76 0.106       at /$bunfs/root/image-smoke:8478:51",
        "#76 0.106 Bun v1.4.2 (Linux arm64)",
        "#76 ERROR: process did not complete successfully: exit code: 1",
      ].join("\n"),
    }),
  ).toEqual([
    "::error title=API image build (linux/arm64)::ENOENT: no such file or directory, open '/app/yara'",
    "::error title=API image build (linux/arm64)::ERROR: process did not complete successfully: exit code: 1",
  ]);
  expect(
    annotate({
      build: [
        "#20 [builder 9/40] RUN false",
        "#20 0.100 last words",
        "#20 ERROR: process did not complete successfully: exit code: 1",
      ].join("\n"),
    }),
  ).toEqual([
    "::error title=API image build (linux/arm64)::last words",
    "::error title=API image build (linux/arm64)::ERROR: process did not complete successfully: exit code: 1",
  ]);
  expect(annotate({ build: "ERROR: failed to solve: pull failed\n" })).toEqual([
    "::error title=API image build (linux/arm64)::ERROR: failed to solve: pull failed",
  ]);
});

test("marketing screenshots are planned only for ready same-repository releases or release tags", () => {
  const plan = v.parse(
    v.object({
      outputs: v.record(v.string(), v.string()),
      steps: v.array(
        v.object({ name: v.optional(v.string()), run: v.optional(v.string()) }),
      ),
    }),
    ciJobs["ci-plan"],
  );
  expect(plan.outputs["marketing_screenshots_required"]).toBe(
    ["$", "{{ steps.marketing-release.outputs.required }}"].join(""),
  );
  const command = v.parse(
    v.string(),
    plan.steps.find(({ name }) => name === "Plan release marketing screenshots")
      ?.run,
  );
  const directory = mkdtempSync(
    nodePath.join(tmpdir(), "marketing-release-plan-"),
  );
  const output = nodePath.join(directory, "output");
  const listing = [
    {
      number: 7,
      title: "chore: release v1.2.3",
      isDraft: false,
      isCrossRepository: false,
    },
    {
      number: 8,
      title: "fix: ordinary",
      isDraft: false,
      isCrossRepository: false,
    },
    {
      number: 9,
      title: "chore: release v1.2.3",
      isDraft: true,
      isCrossRepository: false,
    },
    {
      number: 10,
      title: "chore: release v1.2.3",
      isDraft: false,
      isCrossRepository: true,
    },
  ];
  writeFileSync(
    nodePath.join(directory, "listing.json"),
    JSON.stringify(listing),
  );
  writeFileSync(
    nodePath.join(directory, "gh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      '[[ "$*" == "pr list --repo stella/stella --state open --base main --limit 500 --json number,title,isDraft,isCrossRepository" ]] || exit 3',
      'cat "$(dirname "$0")/listing.json"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const cases = [
    {
      event: "pull_request",
      number: "7",
      ref: "refs/pull/7/merge",
      head: "",
      required: true,
    },
    {
      event: "pull_request",
      number: "8",
      ref: "refs/pull/8/merge",
      head: "",
      required: false,
    },
    {
      event: "pull_request",
      number: "9",
      ref: "refs/pull/9/merge",
      head: "",
      required: false,
    },
    {
      event: "pull_request",
      number: "10",
      ref: "refs/pull/10/merge",
      head: "",
      required: false,
    },
    {
      event: "merge_group",
      number: "",
      ref: "refs/heads/gh-readonly-queue/main/pr-7-abcdef",
      head: "refs/heads/gh-readonly-queue/main/pr-7-abcdef",
      required: true,
    },
    {
      event: "merge_group",
      number: "",
      ref: "refs/heads/gh-readonly-queue/main/pr-8-abcdef",
      head: "refs/heads/gh-readonly-queue/main/pr-8-abcdef",
      required: false,
    },
    {
      event: "workflow_dispatch",
      number: "",
      ref: "refs/tags/v1.2.3",
      head: "",
      required: true,
    },
    {
      event: "workflow_dispatch",
      number: "",
      ref: "refs/tags/ordinary",
      head: "",
      required: false,
    },
    {
      event: "workflow_dispatch",
      number: "",
      ref: "refs/heads/main",
      head: "",
      required: false,
    },
  ];
  try {
    for (const { event, number, ref, head, required } of cases) {
      writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-eu", "-c", command], {
        cwd: nodePath.resolve(import.meta.dir, ".."),
        env: {
          PATH: `${directory}:${Bun.env["PATH"] ?? ""}`,
          EVENT_NAME: event,
          PR_NUMBER: number,
          GITHUB_REF: ref,
          MERGE_GROUP_HEAD_REF: head,
          REPOSITORY: "stella/stella",
          GITHUB_OUTPUT: output,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      expect(readFileSync(output, "utf-8"), `${event} ${ref}`).toBe(
        `required=${String(required)}\n`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("spec-tree PRs plan production shards and their web build at fast depth", () => {
  for (const file of [
    "apps/web/e2e/specs/new.spec.ts",
    "apps/web/e2e/helpers/test.ts",
    "apps/web/e2e/fixtures/simple.docx",
    "apps/web/e2e/playwright.config.ts",
  ]) {
    const planned = runSelector(
      [file],
      ["e2e_production_required", "web_build_required"],
    );
    expect(planned, file).toEqual(["true", "true"]);
    expect(jobScopes["e2e-production-shard"]).toBe("e2e_production_required");
    expect(fastJobScopes["web-build"]).toBe("web_build_pr_required");
    expect(jobIf(ciJobs["web-build"])).toContain(
      "needs.ci-plan.outputs.web_build_pr_required == 'true'",
    );
    expect(jobIf(ciJobs["e2e-production-shard"])).toContain(
      "needs.ci-plan.outputs.e2e_production_required == 'true'",
    );
    expect(fastRequired).toContain("e2e-production-shard");
    expect(fastRequired).toContain("web-build");
    expect(
      evaluateResult({
        event: EVENT.pullRequest,
        results: { "e2e-production-shard": "skipped" },
      }),
    ).toBe(1);
    expect(
      evaluateResult({
        event: EVENT.pullRequest,
        results: { "e2e-production-shard": "failure" },
      }),
    ).toBe(1);
  }
});

test("PR e2e selection schedules its build and shard together", () => {
  const selected = {
    event: EVENT.pullRequest,
    depth: SUITE_DEPTH.fast,
  } as const;
  expect(runsAtDepth(jobIf(ciJobs["web-build"]), selected)).toBe(true);
  expect(runsAtDepth(jobIf(ciJobs["e2e-production-shard"]), selected)).toBe(
    true,
  );

  const values = {
    "github.event_name": EVENT.pullRequest,
    "inputs.heavy_only": false,
    "needs.ci-plan.outputs.run_required": "true",
    "needs.ci-plan.outputs.trusted": "true",
    "needs.ci-plan.outputs.coverage_profile": "normal-v1",
    "needs.ci-plan.outputs.queue_depth": "full",
    "needs.ci-plan.outputs.web_build_required": "false",
    "needs.ci-plan.outputs.web_build_pr_required": "false",
    "needs.ci-plan.outputs.e2e_production_required": "false",
    "needs.web-build.result": "skipped",
    "needs.heavy-web-build.result": "skipped",
    "vars.QUEUE_BROWSER_SUITES": "",
  };
  expect(
    evaluate(jobIf(ciJobs["web-build"]), {
      values,
      status: { always: true, success: true, failure: false, cancelled: false },
    }),
  ).toBe(false);
  expect(
    evaluate(jobIf(ciJobs["e2e-production-shard"]), {
      values,
      status: { always: true, success: true, failure: false, cancelled: false },
    }),
  ).toBe(false);
  expect(runSelector(["README.md"], ["e2e_production_required"])).toEqual([
    "false",
  ]);
});

type PlaywrightSelectionOptions = {
  mode: "full" | "selected";
  specs: string;
  shard?: number;
};

const runPlaywrightSelection = ({
  mode,
  specs,
  shard = 1,
}: PlaywrightSelectionOptions) => {
  const step = jobSteps(ciJobs["e2e-production-shard"]).find(
    ({ name }) => name === "Run Playwright shard",
  );
  const run = step?.run ?? panic("Missing Playwright shard step");
  expect(step?.env?.["E2E_MODE"]).toBe(
    `\${{ needs.ci-plan.outputs.e2e_production_mode }}`,
  );
  expect(step?.env?.["E2E_SPECS"]).toBe(
    `\${{ needs.ci-plan.outputs.e2e_production_specs }}`,
  );
  return Bun.spawnSync(
    [
      "bash",
      "-c",
      `bash() { printf '%s\\n' "$@"; }\n${run
        .replaceAll(/\$\{\{ matrix\.shard \}\}/gu, () => String(shard))
        .replaceAll(`\${{ steps.e2e-shards.outputs.count }}`, () =>
          String(E2E_SHARD_COUNT),
        )}`,
    ],
    {
      env: {
        PATH: Bun.env["PATH"] ?? "",
        GITHUB_WORKSPACE: nodePath.resolve(import.meta.dir, ".."),
        E2E_MODE: mode,
        E2E_SPECS: specs,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
};

test.each([1, 2, 3, 4])(
  "full Playwright depth shards general and geometry projects independently: %s",
  (shard) => {
    const result = runPlaywrightSelection({ mode: "full", specs: "[]", shard });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      `${nodePath.resolve(import.meta.dir, "..")}/.github/actions/setup-playwright/run-in-image.sh`,
      "bun",
      "--filter",
      "@stll/web",
      "test:e2e",
      "--",
      "--grep-invert=route-smoke",
      "--project=chromium",
      "--project=heap-growth-canary",
      `--shard=${shard}/4`,
      `${nodePath.resolve(import.meta.dir, "..")}/.github/actions/setup-playwright/run-in-image.sh`,
      "bun",
      "--filter",
      "@stll/web",
      "test:e2e",
      "--",
      "--project=docked-chat-geometry",
      `--shard=${shard}/4`,
    ]);
  },
);

test("every production Playwright shard total comes from the matrix shard source", () => {
  const steps = jobSteps(ciJobs["e2e-production-shard"]);
  const countStep = steps.find(
    ({ name }) => name === "Read production E2E shard count",
  );
  expect(countStep?.run).toBe(
    'echo "count=$(bun scripts/e2e-spec-shards-core.ts count)" >> "$GITHUB_OUTPUT"',
  );
  const shardArgument = `--shard=\${{ matrix.shard }}/\${{ steps.e2e-shards.outputs.count }}`;
  const invocationLines = steps.flatMap(({ run }) =>
    (run ?? "").split("\n").filter((line) => line.includes("--shard=")),
  );
  expect(invocationLines).toHaveLength(3);
  expect(invocationLines.every((line) => line.includes(shardArgument))).toBe(
    true,
  );
  expect(E2E_SHARD_COUNT).toBe(4);
});

const queueOnlyJobs = Object.fromEntries(
  Object.entries(eventPolicies.jobs)
    .filter(
      ([key, policy]) =>
        (policy === "queue" ||
          policy === "armed" ||
          key === "ci.yml/service-suites" ||
          key === "ci.yml/postgres-service-suites") &&
        key.startsWith("ci.yml/") &&
        key !== "ci.yml/pr-heavy-gate" &&
        gatedJobs.includes(key.slice("ci.yml/".length)),
    )
    .map(([key]) => [
      key.slice("ci.yml/".length),
      key === "ci.yml/service-suites" ||
      key === "ci.yml/postgres-service-suites"
        ? "Postgres PR switch is off by default"
        : "queue-only until the pull request is armed for merge",
    ]),
);

// Evaluate the actual predicate with a successful trusted plan. Unfamiliar
// expression syntax fails closed instead of silently evading parity.
type DepthContext = {
  event: Event;
  depth: SuiteDepth;
  heavyOnly?: boolean;
  queueDepth?: "full" | "thin";
  prDepthReused?: "false" | "true";
  proveFix?: boolean;
  /** The QUEUE_BROWSER_SUITES repository variable; GitHub reads unset as ''. */
  queueBrowserSuites?: string;
  corpusRequired?: boolean;
  armed?: boolean;
};
const bareExpression = (condition: string) =>
  /^\$\{\{([\s\S]*)\}\}$/u.exec(condition.trim())?.[1] ?? condition;

const runsAtDepth = (
  condition: string,
  {
    event,
    depth,
    heavyOnly,
    queueDepth = "full",
    prDepthReused = "false",
    proveFix = false,
    queueBrowserSuites = "",
    corpusRequired = false,
    armed = false,
  }: DepthContext,
) => {
  const selectedQueueDepth = event === EVENT.mergeGroup ? queueDepth : "full";
  return v.parse(
    v.boolean(),
    evaluate(condition, {
      values: {
        "github.event_name": event,
        "github.event.pull_request.labels.*.name": proveFix
          ? ["prove-fix"]
          : [],
        "github.event.pull_request.draft": false,
        "inputs.heavy_only": heavyOnly === true,
        "inputs.pr_depth_only": false,
        "needs.ci-plan.outputs.pr_depth_reused": prDepthReused,
        // An unarmed pull request; a merge group without armed proof.
        "needs.ci-plan.outputs.heavy_proof": String(
          event !== EVENT.pullRequest || armed,
        ),
        "needs.ci-plan.outputs.coverage_profile": "normal-v1",
        "needs.ci-plan.outputs.pilot_fast_jobs": "[]",
        "needs.ci-plan.outputs.suite_depth": depth,
        "needs.ci-plan.outputs.queue_depth": selectedQueueDepth,
        "vars.QUEUE_BROWSER_SUITES": queueBrowserSuites,
        "vars.CI_POSTGRES_PR_SELECTION": "off",
        "needs.ci-plan.outputs.postgres_pr_required": "false",
        "needs.ci-plan.outputs.corpus_suites_required": String(corpusRequired),
        "needs.ci-plan.outputs.ci_browser_required": browserPlanOutput({
          event,
          depth,
          desktopRequired: "true",
          queueDepth: selectedQueueDepth,
        }),
        "needs.ci-plan.outputs.heavy_web_build_required": String(
          heavyOnly === true,
        ),
        "needs.ci-plan.outputs.pr_heavy_gate_required": String(
          event === EVENT.pullRequest,
        ),
        "needs.pr-heavy-gate.result":
          event === EVENT.pullRequest ? "success" : "skipped",
      },
      status: { always: true, success: true, failure: false, cancelled: false },
      fallback: (path) => {
        if (path.startsWith("needs.ci-plan.outputs.")) {
          return "true";
        }
        if (/^needs\.[\w-]+\.result$/u.test(path)) {
          return "success";
        }
        if (path === "steps.install.outcome") {
          return "success";
        }
        throw new TypeError(`Unknown CI predicate context: ${path}`);
      },
    }),
  );
};

type ParityJob = { name: string; condition: string; required: boolean };
const parityViolations = (
  jobs: readonly ParityJob[],
  exceptions: Record<string, string>,
) => {
  const violations: string[] = [];
  for (const name of Object.keys(exceptions)) {
    const job = jobs.find((candidate) => candidate.name === name);
    if (
      job === undefined ||
      !runsAtDepth(job.condition, {
        event: EVENT.mergeGroup,
        depth: SUITE_DEPTH.full,
      }) ||
      runsAtDepth(job.condition, {
        event: EVENT.pullRequest,
        depth: SUITE_DEPTH.fast,
      })
    ) {
      violations.push(`${name}: stale queue-only exception`);
    }
  }
  for (const job of jobs) {
    if (
      !runsAtDepth(job.condition, {
        event: EVENT.mergeGroup,
        depth: SUITE_DEPTH.full,
      })
    ) {
      continue;
    }
    if (
      runsAtDepth(job.condition, {
        event: EVENT.pullRequest,
        depth: SUITE_DEPTH.fast,
      }) &&
      job.required
    ) {
      continue;
    }
    if (!Object.hasOwn(exceptions, job.name)) {
      violations.push(
        `${job.name}: missing required PR path or queue-only reason`,
      );
    }
  }
  return violations;
};

type ScopedCheck = {
  name: string;
  scope: string;
  condition: string;
  requiredOnPr: boolean;
  requiredOnThin: boolean;
};
const scopedCoverageViolations = (checks: readonly ScopedCheck[]) => {
  const scopes = new Set(checks.map(({ scope }) => scope));
  return [...scopes].filter(
    (scope) =>
      !checks.some(
        (check) =>
          check.scope === scope &&
          (check.requiredOnPr || check.requiredOnThin) &&
          (!check.requiredOnPr ||
            runsAtDepth(check.condition, {
              event: EVENT.pullRequest,
              depth: SUITE_DEPTH.fast,
            })) &&
          (!check.requiredOnThin ||
            ["thin", "full"].every((queueDepth) =>
              runsAtDepth(check.condition, {
                event: EVENT.mergeGroup,
                depth: SUITE_DEPTH.full,
                queueDepth: queueDepth === "thin" ? "thin" : "full",
              }),
            )),
      ),
  );
};

test("a selected PR leg passes only its selected specs without sharding", () => {
  const spec = "apps/web/e2e/specs/guides.spec.ts";
  const result = runPlaywrightSelection({
    mode: "selected",
    specs: JSON.stringify([spec]),
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim().split("\n")).toEqual([
    `${nodePath.resolve(import.meta.dir, "..")}/.github/actions/setup-playwright/run-in-image.sh`,
    "bun",
    "--filter",
    "@stll/web",
    "test:e2e",
    "--",
    "--grep-invert=route-smoke",
    spec,
  ]);
});

test("a selected Playwright leg fails before loading an empty spec list", () => {
  const result = runPlaywrightSelection({ mode: "selected", specs: "[]" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Selected E2E leg has no specs");
  expect(result.stdout.toString()).toBe("");
});

test("production shards keep full-depth core coverage and exclude unrelated fast PRs", () => {
  for (const file of [
    "apps/api/src/handlers/tasks/get.ts",
    "apps/web/src/routes/index.tsx",
    "packages/ui/src/button.tsx",
  ]) {
    expect(runSelector([file], ["e2e_production_required"])).toEqual(["false"]);
    expect(
      runSelector(
        [file],
        ["e2e_production_required"],
        "full",
        "false",
        "merge_group",
      ),
    ).toEqual(["true"]);
  }
  for (const file of [
    "README.md",
    "apps/web/e2e/collab/room.spec.ts",
    "apps/web/e2e/playwright.collab.config.ts",
    "apps/web/e2e/marketing/product.spec.ts",
    "apps/web/e2e/playwright.marketing.config.ts",
  ]) {
    expect(runSelector([file], ["e2e_production_required"])).toEqual(["false"]);
  }
  expect(
    runSelector(
      ["apps/web/e2e/specs/new.spec.ts"],
      ["e2e_production_required"],
      "fast",
      "false",
      "workflow_dispatch",
    ),
  ).toEqual(["false"]);
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "e2e-production-shard": "skipped" },
      unplannedScopes: ["e2e_production_required"],
    }),
  ).toBe(0);
});

test("direct web compiler checks materialize ignored API contracts before checking", () => {
  const nightly = workflowJobs(
    readFileSync(
      new URL("../.github/workflows/nightly-typecheck.yml", import.meta.url),
      "utf-8",
    ),
  );
  const directCompiler =
    /bun (?:run check:query-cache-types|scripts\/typecheck-coverage\.ts|scripts\/typecheck-baseline\.ts --(?:check(?:-delta)?|measure))/u;
  let consumers = 0;
  for (const [workflowName, jobs] of [
    ["ci", ciJobs],
    ["nightly", nightly],
  ] as const) {
    for (const [job, body] of Object.entries(jobs)) {
      const steps = v.parse(
        v.object({
          steps: v.optional(
            v.array(
              v.object({
                run: v.optional(v.string()),
              }),
            ),
            [],
          ),
        }),
        body,
      ).steps;
      let precedingCommands = "";
      for (const step of steps) {
        const commands = step.run ?? "";
        const consumer = directCompiler.exec(commands);
        if (consumer !== null) {
          consumers += 1;
          const beforeCheck =
            precedingCommands + commands.slice(0, consumer.index);
          expect(
            beforeCheck,
            `${workflowName}/${job} generates before direct compiler checks`,
          ).toMatch(
            /bun run generate|bun scripts\/ci-generated-sources\.ts restore/u,
          );
          if (commands.includes("--measure")) {
            expect(
              commands.slice(0, consumer.index),
              `${job} generates in the base checkout`,
            ).toContain("bun --filter @stll/api gen:web-api-types");
          }
        }
        precedingCommands += `${commands}\n`;
      }
    }
  }
  expect(consumers).toBeGreaterThan(0);
});

test("direct web compiler package scripts generate before inspecting types", () => {
  const { tasks } = v.parse(
    v.object({
      tasks: v.record(
        v.string(),
        v.object({
          dependsOn: v.optional(v.array(v.string()), []),
        }),
      ),
    }),
    Bun.JSONC.parse(
      readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
    ),
  );
  const directCompiler =
    /(?:tsc-native\.ts|code-check-affected\.ts|lint-changed\.ts|query-cache-types\.ts|result-consumption\.ts|oxlint\b.*--type-aware)/u;
  let consumers = 0;
  for (const manifest of ["../package.json", "../apps/web/package.json"]) {
    const { name: owner, scripts } = v.parse(
      v.object({ name: v.string(), scripts: v.record(v.string(), v.string()) }),
      JSON.parse(readFileSync(new URL(manifest, import.meta.url), "utf-8")),
    );
    for (const [name, command] of Object.entries(scripts)) {
      const consumer = directCompiler.exec(command);
      if (consumer === null) {
        continue;
      }
      consumers += 1;
      expect(
        command.slice(0, consumer.index),
        `${manifest} ${name} materializes the API contract`,
      ).toMatch(
        /bun run(?: --cwd \.\.\/\.\.)? generate|bun scripts\/ci-generated-sources\.ts prepare/u,
      );
      if (command.includes("$TURBO_HASH")) {
        const task = `${manifest === "../package.json" ? "//" : owner}#${name}`;
        expect(
          tasks[task]?.dependsOn,
          `${task} prepares API types before skipping the nested cache restore`,
        ).toContain(
          manifest === "../package.json"
            ? "@stll/web#generate:api-types"
            : "generate:api-types",
        );
      }
    }
  }
  expect(consumers).toBeGreaterThan(0);
});

test("folded suites are expected only when their producer and suites are planned", () => {
  expect(Object.keys(foldedSuites).length).toBeGreaterThan(0);
  for (const [job, suites] of Object.entries(foldedSuites)) {
    const silent = {
      results: { [job]: "skipped" },
      suiteResults: Object.fromEntries(
        Object.keys(suites).map((suite) => [suite, ""]),
      ),
    };
    const scope = jobScopes[job];
    const unplannedScopes = [
      ...Object.values(suites),
      ...(typeof scope === "string" ? [scope] : []),
    ];
    for (const heavyOnly of [false, true]) {
      expect(
        evaluateResult({
          event: EVENT.workflowDispatch,
          heavyOnly,
          unplannedScopes,
          ...silent,
        }),
        `${job} unplanned, heavyOnly=${heavyOnly}`,
      ).toBe(0);
      expect(
        evaluateResult({ event: EVENT.workflowDispatch, heavyOnly, ...silent }),
        `${job} planned, heavyOnly=${heavyOnly}`,
      ).toBe(1);
    }
  }
});

test("folded Docker suites keep their scopes and fail independently, including missing or cancelled verdicts", () => {
  expect(foldedSuites["docker-checks"]).toEqual({
    "agent-sandbox-docker": "agent_sandbox_docker_required",
    "api-image-deps": "api_image_deps_required",
  });
  for (const [job, suites] of Object.entries(foldedSuites)) {
    const body = v.parse(
      v.object({
        outputs: v.record(v.string(), v.string()),
        steps: v.array(
          v.object({
            id: v.optional(v.string()),
            if: v.optional(v.string()),
            run: v.optional(v.string()),
          }),
        ),
      }),
      ciJobs[job],
    );
    expect(new Set(Object.keys(body.outputs))).toEqual(
      new Set(Object.keys(suites)),
    );
    for (const [suite, scope] of Object.entries(suites)) {
      expect(
        body.steps.some((step) =>
          step.if?.includes(`needs.ci-plan.outputs.${scope} == 'true'`),
        ),
      ).toBe(true);
      for (const verdict of [
        "failure",
        "cancelled",
        "skipped",
        "timed_out",
        "",
      ]) {
        expect(
          evaluateResult({
            event: EVENT.mergeGroup,
            results: {},
            suiteResults: { [suite]: verdict },
          }),
          `${suite}: ${verdict}`,
        ).toBe(1);
        expect(
          evaluateResult({
            event: EVENT.mergeGroup,
            results: {},
            suiteResults: { [suite]: verdict },
            unplannedScopes: [scope],
          }),
          `${suite}: unplanned ${verdict}`,
        ).toBe(0);
      }
    }
    const sandboxVerdict = body.outputs["agent-sandbox-docker"] ?? "";
    const sandboxSteps = body.steps.filter(
      (step) =>
        step.id !== undefined &&
        step.if?.includes(
          "needs.ci-plan.outputs.agent_sandbox_docker_required == 'true'",
        ),
    );
    const verdictSteps = [
      ...sandboxVerdict.matchAll(/steps\.([\w-]+)\.outcome == 'success'/gu),
    ].map((match) => match.at(1));
    expect(new Set(verdictSteps)).toEqual(
      new Set(sandboxSteps.map((step) => step.id)),
    );
    const api = body.steps.find((step) => step.id === "api-deps");
    expect(api?.if).toContain("!cancelled()");
    expect(api?.run).toContain("--frozen-lockfile --ignore-scripts");
    expect(api?.run).toContain(
      "--production --frozen-lockfile --ignore-scripts",
    );
    expect(api?.run).toContain(
      "bun apps/legal-atlas-runner/dist/index.js smoke",
    );
    expect(body.outputs["agent-sandbox-docker"]).toContain(
      "steps.isolation.outcome == 'success'",
    );
    expect(body.outputs["agent-sandbox-docker"]).toContain(
      "steps.cleanup.outcome == 'success'",
    );
    expect(body.outputs["api-image-deps"]).toBe(
      ["$", "{{ steps.api-deps.outcome }}"].join(""),
    );
  }
});

test("folded verdicts remain mandatory on main-heavy and thin queues", () => {
  const gates: ExpectedResultGate[] = [];
  for (const context of [
    { event: EVENT.workflowDispatch, heavyOnly: true },
    { event: EVENT.mergeGroup, plannedOutputs: { queue_depth: "thin" } },
  ] as const) {
    gates.push({
      label: `${context.event}: successful folded verdicts`,
      options: { ...context, results: {} },
      exitCode: 0,
    });
    for (const suites of Object.values(foldedSuites)) {
      for (const [suite, scope] of Object.entries(suites)) {
        for (const verdict of ["failure", "skipped", "cancelled", ""]) {
          const options = {
            ...context,
            results: {},
            suiteResults: { [suite]: verdict },
          };
          gates.push({
            label: `${context.event}/${suite}/${verdict}`,
            options,
            exitCode: 1,
          });
          gates.push({
            label: `${context.event}/${suite}/unplanned/${verdict}`,
            options: { ...options, unplannedScopes: [scope] },
            exitCode: 0,
          });
        }
      }
    }
  }
  expectResultGates(gates);
});

test("the Docker fold is planned by either original scope without changing the suite selectors", () => {
  for (const files of [
    [],
    ["README.md"],
    ["scripts/retry.sh"],
    ["apps/api/src/index.ts"],
    ["bun.lock"],
  ]) {
    const [sandbox, imageDeps, folded] = runSelector(
      files,
      [
        "agent_sandbox_docker_required",
        "api_image_deps_required",
        "docker_checks_required",
      ],
      "full",
    );
    expect(folded).toBe(
      sandbox === "true" || imageDeps === "true" ? "true" : "false",
    );
  }
});

test("folded image checks preserve separate working directories for frozen installs and production smoke", () => {
  const directory = realpathSync(
    mkdtempSync(nodePath.join(tmpdir(), "folded-image-deps-")),
  );
  const bin = nodePath.join(directory, "bin");
  mkdirSync(bin);
  mkdirSync(nodePath.join(directory, "apps"));
  mkdirSync(nodePath.join(directory, "packages"));
  writeFileSync(nodePath.join(directory, "bun.lock"), "{}");
  writeFileSync(nodePath.join(directory, "package.json"), "{}");
  writeFileSync(
    nodePath.join(bin, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s:%s\n' "$PWD" "$*" >> "$0.log"
case "$*" in
  -p*) echo 2.0.0 ;;
  *'run case-law-ingest __smoke__') echo 'Unknown adapter: __smoke__'; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    nodePath.join(bin, "turbo"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "prune @stll/legal-atlas-runner --docker --out-dir out-runner" ]]
mkdir -p out-runner/full
`,
    { mode: 0o755 },
  );
  const api = jobSteps(ciJobs["docker-checks"]).find(
    ({ name }) => name === "Check image dependency trees and production runner",
  );
  try {
    const result = Bun.spawnSync(["bash", "-eu", "-c", api?.run ?? "exit 1"], {
      cwd: directory,
      // GitHub sets RUNNER_TEMP; bounded installs write their logs below it.
      env: {
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        RUNNER_TEMP: directory,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    const commands = readFileSync(nodePath.join(bin, "bun.log"), "utf-8");
    expect(commands).toContain(
      `${directory}/api-install:../scripts/ci-install.ts ${directory}/bun-install/api-image.log --filter @stll/api --filter @stll/collab --filter @stll/legal-atlas-runner --frozen-lockfile --ignore-scripts`,
    );
    expect(commands).toContain(
      `${directory}/runner-install:../scripts/ci-install.ts ${directory}/bun-install/legal-atlas.log --filter @stll/legal-atlas-runner --production --frozen-lockfile --ignore-scripts`,
    );
    expect(commands).toContain(
      `${directory}/runner-install:apps/legal-atlas-runner/dist/index.js smoke`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every parallel quality and guard leg fails closed at full depth", () => {
  for (const job of [
    "code-quality-api",
    "code-quality-web-rest",
    "ci-checks-generated",
    "ci-checks-policy",
    "ci-checks-rest",
  ]) {
    expect(resultJob.needs).toContain(job);
    expect(jobScopes[job]).toBe("package_checks_required");
    for (const event of FULL_DEPTH_EVENTS) {
      for (const result of ["failure", "cancelled", "skipped", ""]) {
        expect(
          evaluateResult({
            event,
            suiteDepth: SUITE_DEPTH.full,
            results: { [job]: result },
          }),
          `${event} ${job} ${result}`,
        ).toBe(1);
      }
    }
  }
});

test("Postgres service shards bind every matrix leg to a distinct runner partition", () => {
  const job = v.parse(
    v.object({
      "timeout-minutes": v.number(),
      strategy: v.object({
        "fail-fast": v.boolean(),
        matrix: v.object({ shard: v.array(v.number()) }),
      }),
    }),
    ciJobs["postgres-service-suites"],
  );
  const shards = job.strategy.matrix.shard;
  expect(shards.length).toBeGreaterThanOrEqual(2);
  expect(shards.length).toBeLessThanOrEqual(3);
  expect(shards).toEqual([...POSTGRES_TEST_SHARD_IDS]);
  expect(POSTGRES_SHARD_TEST_BUDGET_SECONDS).toBeLessThanOrEqual(
    job["timeout-minutes"] * 60 * 0.7,
  );
  expect(job.strategy["fail-fast"]).toBe(false);
  expect(job["timeout-minutes"]).toBe(15);
  const runner = jobSteps(ciJobs["postgres-service-suites"]).find(
    (step) => step.name === "Run Postgres-gated API suites",
  );
  expect(runner?.env?.["CI_POSTGRES_TEST_SHARD"]).toBe(
    `\${{ matrix.shard }}/${shards.length}`,
  );
});

test("split service suites preserve their scopes and independent verdicts", () => {
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  expect(plan.outputs["service_suites_required"]).toBe(
    `\${{ steps.changed-files.outputs.package_checks_required == 'true' || steps.changed-files.outputs.collab_redis_required == 'true' }}`,
  );
  expect(jobScopes["service-suites"]).toBe("service_suites_required");
  expect(jobScopes["postgres-service-suites"]).toBe(
    "postgres_service_suites_required",
  );
  expect(fastJobScopes["postgres-service-suites"]).toBe(
    "postgres_service_suites_required",
  );
  expect(ciJobs).not.toHaveProperty("collab-redis");
  const services = v.parse(
    v.object({
      services: v.record(v.string(), v.object({ ports: v.array(v.string()) })),
      steps: v.array(
        v.object({
          name: v.string(),
          if: v.optional(v.string()),
          run: v.optional(v.string()),
          env: v.optional(v.record(v.string(), v.string())),
        }),
      ),
    }),
    ciJobs["service-suites"],
  );
  const suites = [
    ...jobSteps(ciJobs["postgres-service-suites"]),
    ...services.steps,
  ].filter(
    ({ run }) =>
      run?.includes("bun run test:") ||
      run?.includes("@stll/collab test ") ||
      run === "bun scripts/run-corpus-engine-suites.ts",
  );
  expect(suites.map(({ name }) => name)).toEqual([
    "Run Postgres-gated API suites",
    "Run corpus engine suites",
    "Run Valkey-gated API suites",
    "Run cross-replica collaboration suite",
  ]);
  const suiteScopes = [
    ["Run Postgres-gated API suites", "postgres_suites_required"],
    ["Run corpus engine suites", "corpus_suites_required"],
    ["Run Valkey-gated API suites", "valkey_suites_required"],
    ["Run cross-replica collaboration suite", "collaboration_suite_required"],
  ] as const;
  const nonCorpusGate =
    "(github.event_name != 'pull_request' || vars.CI_POSTGRES_PR_SELECTION == 'on') && (needs.ci-plan.outputs.suite_depth == 'full' || (needs.ci-plan.outputs.suite_depth == 'fast' && needs.ci-plan.outputs.service_suites_pr_required == 'true'))";
  for (const suite of suites) {
    const scope = suiteScopes.find(([name]) => name === suite.name)?.[1];
    if (scope === undefined) {
      throw new TypeError("No service scope for suite");
    }
    const predicate = `needs.ci-plan.outputs.${scope} == 'true'`;
    if (scope === "corpus_suites_required") {
      expect(suite.if).toBe(`\${{ !cancelled() && ${predicate} }}`);
      continue;
    }
    expect(suite.if).toBe(
      scope === "postgres_suites_required"
        ? `${predicate} && ${nonCorpusGate}`
        : `\${{ !cancelled() && ${predicate} && ${nonCorpusGate} }}`,
    );
  }
  const collab = suites.find(({ run }) => run?.includes("@stll/collab"));
  const valkey = suites.find(({ run }) => run === "bun run test:valkey");
  expect(collab?.env?.["STELLA_COLLAB_TEST_REDIS_CONTAINER_ID"]).toBe(
    `\${{ job.services.redis.id }}`,
  );
  const collabPort = new URL(
    collab?.env?.["STELLA_COLLAB_TEST_REDIS_URL"] ?? "",
  ).port;
  const valkeyPort = new URL(valkey?.env?.["REDIS_URL"] ?? "").port;
  expect(collabPort).not.toBe(valkeyPort);
  expect(services.services["redis"]?.ports).toEqual([`${collabPort}:6379`]);
  expect(services.services["valkey"]?.ports).toEqual([`${valkeyPort}:6379`]);
  for (const event of FULL_DEPTH_EVENTS) {
    for (const job of ["postgres-service-suites", "service-suites"]) {
      for (const result of ["failure", "cancelled", "skipped"]) {
        expect(evaluateResult({ event, results: { [job]: result } })).toBe(1);
      }
    }
    expect(
      evaluateResult({
        event,
        results: {
          "service-suites": "skipped",
          "postgres-service-suites": "skipped",
        },
        unplannedScopes: [
          "service_suites_required",
          "service_suites_pr_required",
          "postgres_service_suites_required",
        ],
      }),
    ).toBe(0);
  }
  for (const event of [EVENT.pullRequest, ...FULL_DEPTH_EVENTS]) {
    for (const scope of [
      "corpus_suites_required",
      "collaboration_suite_required",
    ]) {
      expect(
        evaluateResult({
          event,
          results: { "postgres-service-suites": "skipped" },
          plannedOutputs: {
            [scope]: "true",
            postgres_suites_required: "false",
            postgres_service_suites_required: "false",
          },
        }),
        `${event} ${scope}`,
      ).toBe(0);
    }
  }
});

test("Bun cache saves are main-only and trusted Turbo results remain readable", () => {
  const configured = v.parse(
    v.object({ env: v.record(v.string(), v.string()) }),
    Bun.YAML.parse(workflow),
  );
  expect(configured.env["TURBO_CACHE"]).toBe(
    `\${{ ((github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'merge_group' || (github.event_name == 'schedule' && github.ref == 'refs/heads/main' && inputs.task_cache_producer == 'validated-main' && inputs.heavy_only == true && inputs.sha == github.sha)) && 'local:rw,remote:rw' || 'local:rw,remote:r' }}`,
  );
  const cacheSteps = Object.values(ciJobs)
    .flatMap(
      (job) =>
        v.parse(
          v.object({
            steps: v.optional(
              v.array(
                v.object({
                  uses: v.optional(v.string()),
                  with: v.optional(v.record(v.string(), v.unknown())),
                }),
              ),
              [],
            ),
          }),
          job,
        ).steps,
    )
    .filter(({ uses }) =>
      uses?.startsWith("stella/.github/actions/setup-bun-cached@"),
    );
  expect(cacheSteps.length).toBeGreaterThan(0);
  for (const step of cacheSteps) {
    expect(step.with?.["save"]).toBe(`\${{ github.ref == 'refs/heads/main' }}`);
  }
});

test("property-testing guards run only when dependencies are installed", () => {
  let guardCount = 0;
  for (const job of [
    "ci-checks-generated",
    "ci-checks-policy",
    "ci-checks-rest",
  ]) {
    const steps = jobSteps(ciJobs[job]);
    const installCondition =
      "needs.ci-plan.outputs.package_checks_required == 'true'";
    const install = steps.find(({ name }) => name === "Install dependencies");
    if (job === "ci-checks-policy") {
      expect(install?.if).toContain("steps.checkout.outcome == 'success'");
    } else {
      expect(install?.if).toContain(`(${installCondition})`);
    }
    const guards = steps.filter(({ run }) =>
      run?.includes("bun test packages/property-testing/"),
    );
    guardCount += guards.length;
    if (guards.length > 0) {
      expect(installCondition, job).toBeDefined();
    }
    for (const guard of guards) {
      expect(guard.if, `${job}: ${String(guard.name)}`).toBe(
        `\${{ !cancelled() && steps.install.outcome == 'success' && (${installCondition}) }}`,
      );
    }
  }
  expect(guardCount).toBeGreaterThan(0);
});

test("dependency inputs plan a malware scan and unrelated paths do not", () => {
  for (const depth of ["fast", "full"]) {
    for (const file of [
      "bun.lock",
      ".claude/mcp/bun.lock",
      "package.json",
      "apps/web/package.json",
      "tools/docs/yarn.lock",
    ]) {
      expect(
        runSelector([file], ["dependency_malware_required"], depth),
      ).toEqual(["true"]);
    }
    expect(
      runSelector(
        ["apps/web/src/page.tsx"],
        ["dependency_malware_required"],
        depth,
      ),
    ).toEqual(["false"]);
  }
});

test("planned malware scan gates fast PRs and full merge groups", () => {
  expect(jobScopes["dependency-malware"]).toBe("dependency_malware_required");
  expect(fastRequired).toContain("dependency-malware");
  for (const event of [EVENT.pullRequest, EVENT.mergeGroup]) {
    for (const verdict of ["failure", "cancelled", "skipped"]) {
      expect(
        evaluateResult({ event, results: { "dependency-malware": verdict } }),
      ).toBe(1);
    }
    expect(
      evaluateResult({ event, results: { "dependency-malware": "success" } }),
    ).toBe(0);
    expect(
      evaluateResult({
        event,
        results: { "dependency-malware": "skipped" },
        unplannedScopes: ["dependency_malware_required"],
      }),
    ).toBe(0);
  }
});

test("only the dedicated malware gate activates Safe Chain and keeps Bun packages cold", () => {
  const users = Object.entries(ciJobs)
    .filter(([, job]) => {
      const parsed = v.parse(
        v.object({
          steps: v.optional(
            v.array(v.object({ uses: v.optional(v.string()) })),
            [],
          ),
        }),
        job,
      );
      return parsed.steps.some(
        ({ uses }) => uses === "./.github/actions/safe-chain",
      );
    })
    .map(([name]) => name);
  expect(users).toEqual(["dependency-malware"]);
  const job = v.parse(
    v.object({
      steps: v.array(
        v.object({ uses: v.optional(v.string()), run: v.optional(v.string()) }),
      ),
    }),
    ciJobs["dependency-malware"],
  );
  expect(
    job.steps.some(
      ({ uses }) =>
        uses?.includes("setup-bun-cached") ||
        uses?.startsWith("actions/cache@"),
    ),
  ).toBe(false);
  expect(
    job.steps.some(({ uses }) => uses === "./.github/actions/osv-scanner"),
  ).toBe(true);
  expect(
    job.steps.some(
      ({ run }) => run === "bash scripts/scan-dependency-malware.sh",
    ),
  ).toBe(true);
  expect(
    job.steps.some(
      ({ run }) => run === "bash scripts/test-malware-scanners.sh",
    ),
  ).toBe(true);
});

test("every browser suite runs on its required matrix legs, the playground on every shard leg", () => {
  const browser = v.parse(
    v.object({
      strategy: v.object({
        "fail-fast": v.literal(false),
        matrix: v.object({ suite: v.string() }),
      }),
      steps: v.array(
        v.object({
          name: v.string(),
          if: v.optional(v.string()),
          run: v.optional(v.string()),
        }),
      ),
    }),
    ciJobs["ci-browser"],
  );
  const matrixSuites = v.parse(
    v.array(v.string()),
    evaluate(browser.strategy.matrix.suite, {
      values: { "github.event_name": "merge_group" },
    }),
  );
  const playgroundLegs = matrixSuites.filter((leg) =>
    leg.startsWith("playground-"),
  );
  expect(new Set(matrixSuites)).toEqual(
    new Set(["desktop", "ui", ...playgroundLegs]),
  );
  expect(matrixSuites).toHaveLength(2 + playgroundLegs.length);
  expect(playgroundLegs.length).toBeGreaterThan(1);
  expect(
    evaluate(browser.strategy.matrix.suite, {
      values: { "github.event_name": "pull_request" },
    }),
  ).toEqual(["desktop"]);
  const suites = browser.steps.filter(
    ({ run }) => run?.includes("test:browser") || run?.includes("test:e2e"),
  );
  expect(suites.map(({ name }) => name).toSorted(compareCodeUnit)).toEqual(
    [
      "Test desktop browser interactions",
      "Test extension browser boundary",
      "Test UI browser interactions",
      "Test UI playground visuals",
    ].toSorted(compareCodeUnit),
  );
  for (const suite of suites) {
    const legs = matrixSuites.filter((leg) =>
      suite.if?.includes(`matrix.suite == '${leg}'`),
    );
    // The playground suite is the only sharded one: it runs on every
    // playground leg, each taking one Playwright shard of as many as there
    // are legs, so a leg can neither be dropped nor duplicate another's tests.
    if (suite.name === "Test UI playground visuals") {
      expect(legs, suite.name).toEqual(playgroundLegs);
      expect(suite.run, suite.name).toContain(
        `--shard="\${SUITE#playground-}/${String(playgroundLegs.length)}"`,
      );
    } else {
      expect(legs, suite.name).toHaveLength(1);
    }
    expect(suite.if, suite.name).toContain("outputs.required == 'true'");
  }
  expect(resultJob.needs).toContain("ci-browser");
  expect(jobScopes["ci-browser"]).toBe("ci_browser_required");
  for (const event of FULL_DEPTH_EVENTS) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      expect(evaluateResult({ event, results: { "ci-browser": result } })).toBe(
        1,
      );
    }
  }
});

test("route-relevant changes plan the required merge-group smoke", () => {
  const scope = "route_smoke_required";
  const selectedBy = jobIf(ciJobs["route-smoke"]);
  expect(selectedBy).toContain(`needs.ci-plan.outputs.${scope} == 'true'`);
  expect(selectedBy).toContain("github.event_name == 'merge_group'");
  expect(selectedBy).toContain("needs.web-build.result == 'success'");
  expect(heavyJobs).toContain("route-smoke");
  expect(jobScopes["route-smoke"]).toBe(scope);
  expect(fastRequired).not.toContain("route-smoke");
  for (const file of [
    "apps/web/src/routes/_authenticated/matters.tsx",
    "apps/web/src/routeTree.gen.ts",
    "apps/web/src/lib/react-query.ts",
    "apps/web/src/components/new-query-component.tsx",
    "apps/api/src/handlers/tasks/get.ts",
    "packages/ui/src/button.tsx",
    "apps/web/e2e/network-baseline.json",
    "scripts/network-baseline-scope.ts",
    "scripts/network-baseline-scope.test.ts",
    "scripts/network-baseline-comparison.test.ts",
    "apps/web/e2e/network-budgets/feature.json",
    ".github/actions/prepare-network-baseline/action.yml",
    ".github/actions/prepare-network-baseline/prepare.sh",
    "apps/web/e2e/specs/route-smoke.spec.ts",
    "apps/web/e2e/helpers/network.ts",
    "apps/web/e2e/helpers/workspace.ts",
    "apps/web/e2e/playwright.config.ts",
  ]) {
    expect(runSelector([file], [scope]), file).toEqual(["true"]);
  }
  expect(runSelector(["docs/example.md"], [scope])).toEqual(["false"]);
  expect(runSelector([], [scope])).toEqual(["false"]);
  for (const event of [EVENT.workflowDispatch]) {
    expect(
      runSelector(
        ["apps/web/src/routes/new.tsx"],
        [scope],
        "full",
        "false",
        event,
      ),
    ).toEqual(["false"]);
  }
  const event = EVENT.mergeGroup;
  expect(evaluateResult({ event, results: { "route-smoke": "skipped" } })).toBe(
    1,
  );
  expect(
    evaluateResult({
      event,
      results: { "route-smoke": "skipped" },
      unplannedScopes: [scope],
    }),
  ).toBe(0);
}, 30_000);

test("a merge group relies on route-smoke after the duplicate matrix leg is removed", () => {
  const event = EVENT.mergeGroup;
  expect(
    evaluateResult({
      event,
      results: {
        "e2e-production-shard": "success",
        "route-smoke": "success",
      },
    }),
  ).toBe(0);
  expect(
    evaluateResult({
      event,
      results: {
        "e2e-production-shard": "success",
        "route-smoke": "failure",
      },
    }),
  ).toBe(1);
  expect(
    evaluateResult({
      event,
      results: {
        "e2e-production-shard": "success",
        "route-smoke": "skipped",
      },
    }),
  ).toBe(1);
});

test("a merge group plans both browser suites for app changes and neither for docs", () => {
  const scopes = ["route_smoke_required", "e2e_production_required"] as const;
  const appChange = [
    "apps/api/src/handlers/workspaces/read-activity.ts",
    "apps/web/src/components/app-sidebar.logic.ts",
    "apps/web/src/components/app-sidebar.tsx",
    "apps/web/src/lib/organization/feature-access/access.logic.ts",
    "apps/web/src/lib/organization/feature-access/surfaces.ts",
    "apps/web/src/routes/-legal-lists-route-gates.dom.test.tsx",
  ];
  expect(
    runSelector(appChange, scopes, "full", "false", EVENT.mergeGroup),
  ).toEqual(["true", "true"]);
  expect(
    runSelector(
      ["README.md", "apps/desktop/README.md"],
      scopes,
      "full",
      "false",
      EVENT.mergeGroup,
    ),
  ).toEqual(["false", "false"]);
}, 30_000);

test("route smoke consumes the production build and fails when its stack cannot run", () => {
  const plan = jobSteps(ciJobs["ci-plan"]).find(
    ({ name }) => name === "Check changed file scope",
  );
  expect(plan?.run).toBe("bun scripts/ci-plan-scope.ts");
  // The production e2e shards consume web-build's artifact: baseline-scope
  // edits need a build even when the ordinary app-source filter would not
  // select it.
  expect(
    runSelector(
      ["scripts/network-baseline-check.ts"],
      ["e2e_core_required", "route_smoke_required", "web_build_required"],
    ),
  ).toEqual(["true", "true", "true"]);
  expect(workflow).toContain(
    [
      "route_smoke_required: $",
      "{{ steps.changed-files.outputs.route_smoke_required }}",
    ].join(""),
  );
  const upload = jobSteps(ciJobs["web-build"]).find(
    ({ name }) => name === "Upload production E2E web build",
  );
  expect(upload?.if).toContain(
    "needs.ci-plan.outputs.route_smoke_required == 'true'",
  );
  const steps = jobSteps(ciJobs["route-smoke"]);
  const smoke = steps.find(
    ({ name }) => name === "Check route network baseline",
  );
  expect(smoke?.run).toContain("route-smoke.spec.ts --project=route-smoke");
  // The shared setup fails the job when the stack is not ready, so the
  // smoke can never pass without running.
  const routeSmoke = ciJobs["route-smoke"];
  const rawSteps = flattenWorkflowSteps(
    typeof routeSmoke === "object" &&
      routeSmoke !== null &&
      "steps" in routeSmoke
      ? routeSmoke.steps
      : undefined,
  );
  const setup = rawSteps.find(({ id }) => id === "e2e-stack");
  expect(setup?.["uses"]).toBe("./.github/actions/setup-production-e2e");
  expect(smoke?.if ?? "").not.toContain("always()");
});

test("an unreadable PR diff requires route smoke while manual and queue runs retain their suites", () => {
  for (const event of Object.values(EVENT)) {
    const scope = computeChangedFileScope({
      changedFiles: [],
      comparisonBase: "",
      scopeUnknown: true,
      eventName: event,
      suiteDepth: SUITE_DEPTH.full,
      heavyOnly: false,
      prTitle: "",
    });
    expect(scope.route_smoke_required, event).toBe(
      String(event === EVENT.pullRequest || event === EVENT.mergeGroup),
    );
  }
});
test("service-suite scopes run on pull requests only for selected corpus coverage", () => {
  const scope = "service_suites_pr_required";
  const condition = jobIf(ciJobs["service-suites"]);
  expect(condition).toContain("needs.ci-plan.outputs.suite_depth == 'fast'");
  expect(condition).toContain(`needs.ci-plan.outputs.${scope} == 'true'`);
  expect(fastJobScopes["service-suites"]).toBe(scope);
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  expect(plan.outputs[scope]).toBe(
    `\${{ steps.changed-files.outputs.${scope} }}`,
  );
  const cases = [
    { file: "apps/api/src/db/schema/new.ts", required: true },
    { file: "apps/api/drizzle/123_new.sql", required: true },
    { file: "apps/api/src/lib/scheduler/new.ts", required: true },
    {
      file: "apps/api/src/handlers/legislation/new-backfill.ts",
      required: true,
    },
    { file: "apps/api/scripts/run-postgres-tests.ts", required: true },
    { file: "apps/api/src/tests/setup-env.ts", required: true },
    {
      file: "apps/api/src/lib/scheduler/runner.postgres.test.ts",
      required: true,
    },
    { file: "apps/collab/src/server.test.ts", required: true },
    {
      file: "apps/api/src/handlers/case-law/ingestion/citation-extractor.ts",
      required: true,
    },
    { file: "docs/guide.md", required: false },
    { file: "apps/web/src/new.tsx", required: false },
    { file: "apps/api/src/unused-new-handler.ts", required: false },
  ];
  // Plans, job conditions and result gates each run as one batch.
  const planned = planSelector(
    cases.map(({ file, required }) => ({
      file,
      files: [file],
      outputs: [scope, "corpus_suites_required"],
      required,
    })),
  ).map(({ item: { file, required }, plan: values }) => ({
    file,
    required,
    selected: values.at(0) === "true",
    corpusSelected: values.at(1) === "true",
  }));
  for (const { file, required, selected } of planned) {
    expect(selected, file).toBe(required);
  }
  // Evaluate the actual job condition with planner outputs at both depths.
  const conditions = planned.flatMap(({ file, selected, corpusSelected }) =>
    ["fast", "full"].map((suiteDepth) => ({
      label: `${file} ${suiteDepth}`,
      executable: condition
        .replaceAll("needs.ci-plan.outputs.service_suites_required", "'true'")
        .replaceAll(
          `needs.ci-plan.outputs.${scope}`,
          () => `'${String(selected)}'`,
        )
        .replaceAll(
          "needs.ci-plan.outputs.corpus_suites_required",
          () => `'${String(corpusSelected)}'`,
        )
        .replaceAll(
          "needs.ci-plan.outputs.suite_depth",
          () => `'${suiteDepth}'`,
        )
        .replaceAll("needs.ci-plan.outputs.trusted", "'true'")
        .replaceAll("needs.ci-plan.outputs.heavy_proof", "'true'")
        .replaceAll("needs.ci-plan.outputs.armed_delta", "'false'")
        .replaceAll("!cancelled()", "'true' == 'true'")
        .replaceAll("needs.ci-plan.result", "'success'")
        .replaceAll("needs.pr-heavy-gate.result", "'success'")
        .replaceAll("github.event_name", "'pull_request'"),
      exitCode: selected && corpusSelected ? 0 : 1,
    })),
  );
  for (const { item, exitCode } of runBashBatch(
    conditions,
    ({ executable }) => ({
      flags: [],
      script: `[[ ${executable} ]]`,
      args: [],
      env: { PATH: Bun.env["PATH"] ?? "" },
    }),
  )) {
    expect(exitCode, item.label).toBe(item.exitCode);
  }
  expectResultGates(
    planned.flatMap(({ file, selected }) =>
      ["success", "failure", "skipped", "cancelled"].map((result) => ({
        label: `${file} ${result}`,
        options: {
          event: EVENT.pullRequest,
          results: { "service-suites": result },
          unplannedScopes: selected ? [] : [scope],
        },
        exitCode: result === "success" || result === "skipped" ? 0 : 1,
      })),
    ),
  );
}, 30_000);

describe("drawn property samples match the shared runner", () => {
  // Compare both consumers under one seed, including the exploratory tier.
  const seed = 20_261_003;
  const drawSamples = <T>(arbitrary: fc.Arbitrary<T>, numRuns: number) =>
    drawPropertySamples(arbitrary, { numRuns, seed }).map(({ value }) => value);

  type DrawsOptions<T> = {
    id: string;
    arbitrary: fc.Arbitrary<T>;
    numRuns: number;
  };
  const expectDraws = <T>({ id, arbitrary, numRuns }: DrawsOptions<T>) => {
    const asserted: T[] = [];
    assertProperty(
      id,
      fc.property(arbitrary, (value) => {
        asserted.push(value);
      }),
      { numRuns, seed },
    );
    expect(drawSamples(arbitrary, numRuns)).toEqual(asserted);
  };

  test("release files", () => {
    expectDraws({
      id: "release files",
      arbitrary: releaseExtraFiles,
      numRuns: 30,
    });
  });
  test("document names", () => {
    expectDraws({
      id: "document names",
      arbitrary: unrelatedDocNames,
      numRuns: 30,
    });
  });
  test("API siblings", () => {
    expectDraws({
      id: "API siblings",
      arbitrary: apiSourceSiblings,
      numRuns: 10,
    });
  });
  test("failed jobs", () => {
    expectDraws({
      id: "failed jobs",
      arbitrary: failedGatedJobs,
      numRuns: 100,
    });
  });
  test("full-depth jobs", () => {
    expectDraws({
      id: "full-depth jobs",
      arbitrary: unsuccessfulFullDepthJobs,
      numRuns: 100,
    });
  });
  test("tuple arguments", () => {
    const separate: unknown[] = [];
    assertProperty(
      "tuple arguments",
      fc.property(
        fc.constantFrom(...gatedJobs),
        fc.constantFrom("failure", "timed_out", ""),
        fc.constantFrom(...Object.values(EVENT)),
        (job, result, event) => {
          separate.push([job, result, event]);
        },
      ),
      { numRuns: 100, seed },
    );
    expect(separate).toEqual(drawSamples(failedGatedJobs, 100));
  });
});

test("image scopes remain planned while pull requests skip execution", () => {
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  for (const { job, broad, scope, cases } of [
    {
      job: "docker-checks",
      broad: "docker_checks_required",
      scope: "docker_checks_pr_required",
      cases: [
        {
          file: "packages/agent-engine/docker/sandbox.Dockerfile",
          required: true,
        },
        { file: "apps/api/Dockerfile", required: true },
        { file: "apps/legal-atlas-runner/src/index.ts", required: true },
        { file: "packages/money/package.json", required: true },
        { file: ".dockerignore", required: false },
        { file: "bun.lock", required: true },
        { file: "apps/api/src/handlers/new.ts", required: false },
        { file: "packages/agent-engine/src/new.ts", required: false },
        { file: ".github/workflows/ci.yml", required: false },
        { file: "docs/guide.md", required: false },
      ],
    },
    {
      job: "legal-atlas-image",
      broad: "legal_atlas_image_required",
      scope: "legal_atlas_image_pr_required",
      cases: [
        { file: "apps/legal-atlas-runner/Dockerfile", required: true },
        { file: "apps/legal-atlas-runner/src/index.ts", required: true },
        { file: "packages/legal-atlas/src/new.ts", required: true },
        { file: ".dockerignore", required: true },
        { file: "bun.lock", required: true },
        { file: "apps/api/src/handlers/new.ts", required: false },
        { file: "docs/guide.md", required: false },
      ],
    },
  ] as const) {
    const condition = jobIf(ciJobs[job]);
    expect(condition, job).toContain(
      "needs.ci-plan.outputs.suite_depth == 'fast'",
    );
    expect(condition, job).toContain(
      `needs.ci-plan.outputs.${scope} == 'true'`,
    );
    expect(fastJobScopes[job], job).toBe(scope);
    expect(fastRequired, job).not.toContain(job);
    expect(plan.outputs[scope], job).toBe(
      `\${{ steps.changed-files.outputs.${scope} }}`,
    );
    for (const { file, required } of cases) {
      const [broadOutput, scopeOutput] = runSelector([file], [broad, scope]);
      const broadPlanned = String(broadOutput);
      const planned = scopeOutput === "true";
      expect(planned, `${job} ${file}`).toBe(required);
      // A pull request never runs an image check the merge queue would skip.
      if (planned) {
        expect(broadPlanned, `${job} ${file}`).toBe("true");
      }
      for (const suiteDepth of ["fast", "full"]) {
        const executable = condition
          .replaceAll(
            `needs.ci-plan.outputs.${broad}`,
            () => `'${broadPlanned}'`,
          )
          .replaceAll(
            `needs.ci-plan.outputs.${scope}`,
            () => `'${String(planned)}'`,
          )
          .replaceAll(
            "needs.ci-plan.outputs.suite_depth",
            () => `'${suiteDepth}'`,
          )
          .replaceAll("needs.ci-plan.outputs.trusted", "'true'")
          .replaceAll("github.event_name", "'pull_request'");
        expect(
          Bun.spawnSync(["bash", "-c", `[[ ${executable} ]]`]).exitCode,
          `${job} ${file} ${suiteDepth}`,
        ).toBe(1);
      }
      for (const result of ["success", "failure", "skipped"]) {
        expect(
          evaluateResult({
            event: EVENT.pullRequest,
            results: { [job]: result },
            unplannedScopes: planned ? [] : [scope],
          }),
          `${job} ${file} ${result}`,
        ).toBe(result === "failure" ? 1 : 0);
      }
    }
  }
}, 30_000);

test("each split service step follows its own dependency scope and execution depth", () => {
  const scopes = [
    "postgres_suites_required",
    "corpus_suites_required",
    "valkey_suites_required",
    "collaboration_suite_required",
  ] as const;
  const packagePlan = runSelector(
    ["packages/api-contract/src/matter-reference.ts"],
    [...scopes, "collab_redis_required", "service_suites_pr_required"],
  );
  expect(packagePlan.at(3)).toBe("true");
  expect(packagePlan.at(4)).toBe("false");
  expect(packagePlan.at(5)).toBe("true");
  const collaboration = jobSteps(ciJobs["service-suites"]).find(
    ({ name }) => name === "Run cross-replica collaboration suite",
  );
  expect(collaboration?.if).toBe(
    `\${{ !cancelled() && needs.ci-plan.outputs.collaboration_suite_required == 'true' && (github.event_name != 'pull_request' || vars.CI_POSTGRES_PR_SELECTION == 'on') && (needs.ci-plan.outputs.suite_depth == 'full' || (needs.ci-plan.outputs.suite_depth == 'fast' && needs.ci-plan.outputs.service_suites_pr_required == 'true')) }}`,
  );
  const planned = Object.fromEntries(
    scopes.map((scope, index) => [scope, packagePlan.at(index)]),
  );
  const evaluateStep = (
    predicate: string,
    values: Record<string, string | undefined>,
  ) =>
    evaluate(predicate, {
      values: {
        ...Object.fromEntries(
          Object.entries(values).map(([scope, value]) => [
            `needs.ci-plan.outputs.${scope}`,
            value,
          ]),
        ),
        "github.event_name": EVENT.mergeGroup,
        "vars.CI_POSTGRES_PR_SELECTION": "off",
        "needs.ci-plan.outputs.queue_depth": "full",
        "needs.ci-plan.outputs.suite_depth": "full",
        "needs.ci-plan.outputs.service_suites_pr_required": "true",
      },
      status: { always: true, success: true, failure: false, cancelled: false },
    });
  expect(evaluateStep(collaboration?.if ?? "false", planned)).toBe(true);
  for (const [name, scope] of [
    ["Run Postgres-gated API suites", "postgres_suites_required"],
    ["Start corpus engine", "corpus_suites_required"],
    ["Run corpus engine suites", "corpus_suites_required"],
    ["Corpus engine diagnostics and cleanup", "corpus_suites_required"],
    ["Run Valkey-gated API suites", "valkey_suites_required"],
    ["Run cross-replica collaboration suite", "collaboration_suite_required"],
  ] as const) {
    const predicate =
      jobSteps(
        ciJobs[
          name === "Run Postgres-gated API suites"
            ? "postgres-service-suites"
            : "service-suites"
        ],
      ).find((step) => step.name === name)?.if ?? "false";
    for (const selected of scopes) {
      const values = Object.fromEntries(
        scopes.map((key) => [key, String(key === selected)]),
      );
      expect(evaluateStep(predicate, values), `${name}: ${selected}`).toBe(
        scope === selected,
      );
    }
  }
  expect(runSelector(["apps/collab/src/server.ts"], scopes, "full")).toEqual([
    "true",
    "true",
    "true",
    "true",
  ]);
  expect(runSelector(["docs/guide.md"], scopes, "full")).toEqual([
    "false",
    "false",
    "false",
    "false",
  ]);
});

test("corpus bypasses non-corpus service depth and PR opt-in gates", () => {
  const steps = [
    ...jobSteps(ciJobs["postgres-service-suites"]),
    ...jobSteps(ciJobs["service-suites"]),
  ];
  const conditions = Object.fromEntries(
    [
      "Run Postgres-gated API suites",
      "Run corpus engine suites",
      "Run Valkey-gated API suites",
      "Run cross-replica collaboration suite",
    ].map((name) => [
      name,
      steps.find((step) => step.name === name)?.if ?? "false",
    ]),
  );
  const commonValues = {
    "needs.ci-plan.outputs.postgres_suites_required": "true",
    "needs.ci-plan.outputs.corpus_suites_required": "true",
    "needs.ci-plan.outputs.valkey_suites_required": "true",
    "needs.ci-plan.outputs.collaboration_suite_required": "true",
    "needs.ci-plan.outputs.service_suites_pr_required": "true",
    "needs.ci-plan.outputs.suite_depth": "full",
    "vars.CI_POSTGRES_PR_SELECTION": "off",
  };

  const thinMergeGroup = {
    ...commonValues,
    "github.event_name": EVENT.mergeGroup,
    "needs.ci-plan.outputs.queue_depth": "thin",
  };
  expect(
    evaluate(conditions["Run corpus engine suites"] ?? "false", {
      values: thinMergeGroup,
      status: { cancelled: false },
    }),
  ).toBe(true);
  expect(
    evaluate(conditions["Run Postgres-gated API suites"] ?? "false", {
      values: thinMergeGroup,
      status: { cancelled: false },
    }),
  ).toBe(true);
  expect(
    evaluate(conditions["Run Valkey-gated API suites"] ?? "false", {
      values: thinMergeGroup,
      status: { cancelled: false },
    }),
  ).toBe(true);
  expect(
    evaluate(conditions["Run cross-replica collaboration suite"] ?? "false", {
      values: thinMergeGroup,
      status: { cancelled: false },
    }),
  ).toBe(true);

  const pullRequest = {
    ...commonValues,
    "github.event_name": EVENT.pullRequest,
    "needs.ci-plan.outputs.queue_depth": "full",
  };
  expect(
    evaluate(conditions["Run corpus engine suites"] ?? "false", {
      values: pullRequest,
      status: { cancelled: false },
    }),
  ).toBe(true);
  expect(
    evaluate(conditions["Run Postgres-gated API suites"] ?? "false", {
      values: pullRequest,
      status: { cancelled: false },
    }),
  ).toBe(false);
});

test("pull requests and merge groups preserve corpus engine detector scope at every depth", () => {
  const scopes = [
    "postgres_suites_required",
    "corpus_suites_required",
    "valkey_suites_required",
    "service_suites_pr_required",
  ] as const;
  const changed = ["apps/api/src/handlers/example.test.ts"];
  expect(runSelector(changed, scopes)).toEqual([
    "true",
    "true",
    "true",
    "true",
  ]);
  expect(runSelector(changed, scopes, "full", "false", "merge_group")).toEqual([
    "true",
    "true",
    "true",
    "true",
  ]);
  expect(runSelector(["docs/guide.md"], scopes)).toEqual([
    "false",
    "false",
    "false",
    "false",
  ]);
  const condition = jobIf(ciJobs["service-suites"]);
  for (const [suiteDepth, queueDepth] of [
    ["fast", "full"],
    ["full", "full"],
    ["fast", "thin"],
    ["full", "thin"],
  ] as const) {
    const executable = condition
      .replaceAll("needs.ci-plan.outputs.run_required", "'true'")
      .replaceAll("needs.ci-plan.outputs.service_suites_required", "'true'")
      .replaceAll("needs.ci-plan.outputs.corpus_suites_required", "'true'")
      .replaceAll("needs.ci-plan.outputs.service_suites_pr_required", "'true'")
      .replaceAll("needs.ci-plan.outputs.trusted", "'true'")
      .replaceAll("needs.ci-plan.outputs.suite_depth", () => `'${suiteDepth}'`)
      .replaceAll("needs.ci-plan.outputs.queue_depth", () => `'${queueDepth}'`)
      .replaceAll("vars.CI_POSTGRES_PR_SELECTION", "'off'")
      .replaceAll("needs.ci-plan.outputs.heavy_proof", "'true'")
      .replaceAll("needs.ci-plan.outputs.armed_delta", "'false'")
      .replaceAll("!cancelled()", "'true' == 'true'")
      .replaceAll("needs.ci-plan.result", "'success'")
      .replaceAll("needs.pr-heavy-gate.result", "'skipped'")
      .replaceAll("github.event_name", "'merge_group'");
    expect(
      Bun.spawnSync(["bash", "-c", `[[ ${executable} ]]`]).exitCode,
      `${suiteDepth} ${queueDepth}`,
    ).toBe(0);
  }
});

test("an empty full-depth diff preserves the original API service-suite selection", () => {
  const outputs = computeChangedFileScope({
    changedFiles: [],
    comparisonBase: "base",
    scopeUnknown: false,
    eventName: "merge_group",
    suiteDepth: "full",
    heavyOnly: false,
    prTitle: "",
  });
  for (const scope of [
    "postgres_suites_required",
    "corpus_suites_required",
    "valkey_suites_required",
  ] as const) {
    expect(outputs[scope]).toBe("true");
  }
  expect(outputs["collaboration_suite_required"]).toBe("false");
});

test("path-scoped lint and test areas have required pre-merge coverage", () => {
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  const scopes = new Set(
    Object.entries(plan.outputs)
      .filter(
        ([scope, source]) =>
          scope.endsWith("_checks_required") &&
          source.includes("steps.changed-files.outputs."),
      )
      .map(([scope]) => scope),
  );
  const admitted = queueAdmittedJobs({ jobs: ciJobs });
  // A shared job's part runs under the job's condition and its own step
  // condition, and the shared job carries the PR and queue requirement.
  const parts = Object.entries(ciJobs).flatMap(([name, body]) =>
    jobScopes[name] === null
      ? v
          .parse(
            v.object({
              steps: v.optional(
                v.array(
                  v.looseObject({
                    name: v.optional(v.string()),
                    if: v.optional(v.string()),
                  }),
                ),
                [],
              ),
            }),
            body,
          )
          .steps.flatMap(({ name: stepName = "", if: stepIf = "true" }) => {
            const part = /^([a-z0-9-]+): /u.exec(stepName)?.[1];
            const scope = [...scopes].find((candidate) =>
              stepIf.includes(`needs.ci-plan.outputs.${candidate} == 'true'`),
            );
            return part === undefined || scope === undefined
              ? []
              : [
                  {
                    name: `${name}/${part}`,
                    scope,
                    condition: `(${bareExpression(jobIf(body))}) && (${bareExpression(stepIf)})`,
                    requiredOnPr: fastRequired.includes(name),
                    requiredOnThin: admitted.includes(name),
                  },
                ];
          })
      : [],
  );
  const checks = Object.entries(ciJobs).flatMap(([name, body]) => {
    const scope = jobScopes[name];
    if (typeof scope !== "string" || !scopes.has(scope)) {
      return [];
    }
    const job = v.parse(
      v.object({
        steps: v.optional(
          v.array(
            v.looseObject({
              name: v.optional(v.string()),
              run: v.optional(v.string()),
            }),
          ),
          [],
        ),
      }),
      body,
    );
    if (
      !job.steps.some(
        ({ name: stepName, run }) =>
          run !== undefined &&
          /\b(?:checks?|clippy|lint|tests?|typecheck)\b/iu.test(stepName ?? ""),
      )
    ) {
      return [];
    }
    expect(jobIf(body), name).toContain(`needs.ci-plan.outputs.${scope}`);
    return [
      {
        name,
        scope,
        condition: jobIf(body),
        requiredOnPr: fastRequired.includes(name),
        requiredOnThin: admitted.includes(name),
      },
    ];
  });
  expect(checks.length).toBeGreaterThan(0);
  expect(parts.map(({ name }) => name)).toContain(
    "ci-quick-checks/ci-checks-docs",
  );
  expect(new Set([...checks, ...parts].map(({ scope }) => scope))).toEqual(
    scopes,
  );
  expect(scopedCoverageViolations([...checks, ...parts])).toEqual([]);
});

test("path-scoped coverage rejects event and queue-depth exclusions", () => {
  const scoped = "needs.ci-plan.outputs.example_checks_required == 'true'";
  const check = {
    name: "example-lint",
    scope: "example_checks_required",
    condition: scoped,
    requiredOnPr: true,
    requiredOnThin: true,
  };
  expect(scopedCoverageViolations([check])).toEqual([]);
  expect(
    scopedCoverageViolations([
      {
        ...check,
        requiredOnThin: false,
        condition: `github.event_name != 'pull_request' && (${scoped})`,
      },
    ]),
  ).toEqual([check.scope]);
  const docker = {
    name: "docker-checks",
    scope: "docker_checks_required",
    condition: jobIf(ciJobs["docker-checks"]),
    requiredOnPr: false,
    requiredOnThin: true,
  };
  expect(scopedCoverageViolations([docker])).toEqual([]);
  expect(
    scopedCoverageViolations([
      {
        ...docker,
        condition: `needs.ci-plan.outputs.queue_depth != 'thin' && (${docker.condition})`,
      },
    ]),
  ).toEqual([docker.scope]);
  const desktop = jobIf(ciJobs["desktop-rust-lint"]);
  expect(
    runsAtDepth(`github.event_name != 'pull_request' && (${desktop})`, {
      event: EVENT.pullRequest,
      depth: SUITE_DEPTH.fast,
    }),
  ).toBe(false);
});

const parityJobs = gatedJobs.map((name) => ({
  name,
  condition: jobIf(ciJobs[name]),
  required: fastRequired.includes(name),
}));

test("every gated merge-group job has a required PR path or an explicit queue-only reason", () => {
  expect(parityViolations(parityJobs, queueOnlyJobs)).toEqual([]);
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  const pathScopes = new Set<ScopeOutput>();
  for (const { name, condition } of parityJobs) {
    if (
      !runsAtDepth(condition, {
        event: EVENT.pullRequest,
        depth: SUITE_DEPTH.fast,
      })
    ) {
      continue;
    }
    expect(jobScopes, name).toHaveProperty(name);
    const scope = fastJobScopes[name] ?? jobScopes[name];
    if (scope !== null && scope !== undefined) {
      expect(plan.outputs, name).toHaveProperty(scope);
      expect(condition, name).toContain(
        `needs.ci-plan.outputs.${scope} == 'true'`,
      );
      // Computed outputs can depend on file scopes as well as event/depth.
      for (const match of (plan.outputs[scope] ?? "").matchAll(
        /steps\.changed-files\.outputs\.(\w+)/gu,
      )) {
        if (match[1] !== undefined) {
          pathScopes.add(v.parse(v.picklist(OUTPUT_ORDER), match[1]));
        }
      }
    }
  }
  const paths = [
    ".github/workflows/ci.yml",
    "bun.lock",
    "VERSION",
    "apps/landing/src/pages/index.astro",
    "apps/api/src/modules/workspaces/workspace.test.ts",
    "apps/desktop/src-tauri/src/lib.rs",
    "apps/web/e2e/playwright.config.ts",
  ];
  const scopes = [...pathScopes];
  expect(
    runSelector(
      paths,
      scopes,
      "fast",
      // The paths change a landing page.
      "true",
      "pull_request",
      "fix: update checks",
    ),
  ).toEqual(
    scopes.map((scope) =>
      scope === "docs_checks_required" ? "false" : "true",
    ),
  );
  expect(
    runSelector(
      ["README.md", "apps/desktop/README.md"],
      ["docs_checks_required"],
      "fast",
      "false",
      "pull_request",
    ),
  ).toEqual(["true"]);
});

test("parity rejects new queue-only jobs, ungated PR paths and stale exemptions", () => {
  const name = "new-check";
  const condition =
    "needs.ci-plan.outputs.new_required == 'true' && needs.ci-plan.outputs.suite_depth == 'full'";
  expect(
    parityViolations(
      [...parityJobs, { name, condition, required: false }],
      queueOnlyJobs,
    ),
  ).toEqual([`${name}: missing required PR path or queue-only reason`]);
  expect(
    parityViolations(
      [
        {
          name,
          condition: "needs.ci-plan.outputs.new_required == 'true'",
          required: false,
        },
      ],
      {},
    ),
  ).toEqual([`${name}: missing required PR path or queue-only reason`]);
  expect(
    parityViolations([], {
      removed: "queue-only because the removed check used the merged tree",
    }),
  ).toEqual(["removed: stale queue-only exception"]);
  expect(
    parityViolations(
      [
        {
          name,
          condition: "needs.ci-plan.outputs.new_required == 'true'",
          required: true,
        },
      ],
      {
        [name]: "queue-only because this check previously used the merged tree",
      },
    ),
  ).toEqual([`${name}: stale queue-only exception`]);
  expect(() =>
    runsAtDepth("contains(github.ref, 'main')", {
      event: EVENT.pullRequest,
      depth: SUITE_DEPTH.fast,
    }),
  ).toThrow("Unknown CI predicate context");
});

test("workflow and planner changes run every planner test as a merge-group gate", () => {
  const root = nodePath.resolve(import.meta.dirname, "..");
  const plannerTests = [
    ...new Bun.Glob(
      "scripts/{ci-*plan*,ci-checks-partition,ci-completed-depth,ci-pr-pilot,ci-pr-depth-workflow,main-heavy*,thin-queue,github-expression}.test.ts",
    ).scanSync({ cwd: root }),
  ];
  expect(plannerTests).toContain("scripts/ci-checks-partition.test.ts");
  expect(plannerTests).toContain("scripts/ci-plan.test.ts");
  const unlisted = new Set(unlistedTests(plannerTests, workflow));
  const owners = new Map<
    string,
    { job: string; step: ReturnType<typeof jobSteps>[number] }[]
  >();
  for (const [job, body] of Object.entries(ciJobs)) {
    if (!v.is(v.object({ steps: v.array(v.unknown()) }), body)) {
      continue;
    }
    for (const step of jobSteps(body)) {
      for (const file of plannerTests) {
        if (
          step.run?.includes(file) ||
          (unlisted.has(file) &&
            step.run?.includes("bun scripts/run-unlisted-script-tests.ts"))
        ) {
          const existing = owners.get(file) ?? [];
          existing.push({ job, step });
          owners.set(file, existing);
        }
      }
    }
  }
  const changes = [
    ".github/workflows/ci.yml",
    ...plannerTests.map((file) => file.replace(/\.test\.ts$/u, ".ts")),
    ...new Bun.Glob(
      "scripts/{ci-*plan*,ci-pr-*,main-heavy*,github-expression}.ts",
    ).scanSync({ cwd: root }),
  ];
  const selections = planSelector(
    [...new Set(changes)].map((file) => ({
      files: [file],
      outputs: ["package_checks_required"],
      suiteDepth: SUITE_DEPTH.full,
      e2eLandingRequired: "false",
      event: EVENT.mergeGroup,
    })),
  );
  for (const { item, plan } of selections) {
    expect(plan, item.files.join(",")).toEqual(["true"]);
  }
  const admitted = queueAdmittedJobs({ jobs: ciJobs });
  const rootChecks = JSON.stringify(
    selectRootChecks({
      changed: changes,
      graph: readSelectionGraph(root),
      pathChange: "content",
    }),
  );
  const gated = new Set<string>();
  for (const file of plannerTests) {
    const selected = owners.get(file) ?? [];
    expect(selected.length, file).toBeGreaterThan(0);
    for (const { job, step } of selected) {
      expect(admitted, file).toContain(job);
      expect(resultJob.needs, file).toContain(job);
      expect(jobScopes[job], job).toBe("package_checks_required");
      const body = v.parse(v.record(v.string(), v.unknown()), ciJobs[job]);
      expect(body["continue-on-error"] ?? false, job).toBe(false);
      expect(step["continue-on-error"] ?? false, file).toBe(false);
      gated.add(job);
      for (const queueDepth of ["thin", "full"] as const) {
        expect(
          runsAtDepth(jobIf(ciJobs[job]), {
            event: EVENT.mergeGroup,
            depth: SUITE_DEPTH.full,
            queueDepth,
          }),
          job,
        ).toBe(true);
        expect(
          evaluate(step.if ?? "true", {
            values: {
              "github.event_name": EVENT.mergeGroup,
              "needs.ci-plan.outputs.package_checks_required": "true",
              "needs.ci-plan.outputs.queue_depth": queueDepth,
              "needs.ci-plan.outputs.root_checks": rootChecks,
              "needs.ci-plan.outputs.suite_depth": SUITE_DEPTH.full,
            },
            status: {
              always: true,
              success: true,
              failure: false,
              cancelled: false,
            },
            fallback: (name) =>
              /^steps\.[\w-]+\.outcome$/u.test(name) ? "success" : undefined,
          }),
          file,
        ).toBe(true);
      }
    }
  }
  for (const job of gated) {
    for (const queueDepth of ["thin", "full"]) {
      for (const result of ["failure", "skipped"]) {
        expect(
          evaluateResult({
            event: EVENT.mergeGroup,
            plannedOutputs: { queue_depth: queueDepth },
            results: { [job]: result },
          }),
          `${job}/${queueDepth}/${result}`,
        ).toBe(1);
      }
    }
  }
});

test("thin merge groups require every scoped code job while full parity stays enforced", () => {
  const admitted = new Set(queueAdmittedJobs({ jobs: ciJobs }));
  for (const { name, condition } of parityJobs) {
    const full = runsAtDepth(condition, {
      event: EVENT.mergeGroup,
      depth: SUITE_DEPTH.full,
    });
    expect(
      runsAtDepth(condition, {
        event: EVENT.mergeGroup,
        depth: SUITE_DEPTH.full,
        queueDepth: "full",
      }),
      name,
    ).toBe(full);
    const thin = runsAtDepth(condition, {
      event: EVENT.mergeGroup,
      depth: SUITE_DEPTH.full,
      queueDepth: "thin",
    });
    if (admitted.has(name)) {
      expect(thin, name).toBe(full);
    } else if (!Object.hasOwn(MERGE_GROUP_EXCEPTIONS, name)) {
      expect(thin, name).toBe(false);
    }
    // Browser configuration cannot disable a planned queue gate.
    expect(
      runsAtDepth(condition, {
        event: EVENT.mergeGroup,
        depth: SUITE_DEPTH.full,
        queueDepth: "thin",
        queueBrowserSuites: "off",
      }),
      `${name}/off`,
    ).toBe(thin);
    for (const event of [EVENT.pullRequest, EVENT.workflowDispatch]) {
      expect(
        runsAtDepth(condition, {
          event,
          depth: SUITE_DEPTH.fast,
          queueDepth: "thin",
        }),
        name,
      ).toBe(runsAtDepth(condition, { event, depth: SUITE_DEPTH.fast }));
    }
  }
  expect(parityViolations(parityJobs, queueOnlyJobs)).toEqual([]);
  expect(
    runsAtDepth(jobIf(ciJobs["service-suites"]), {
      event: EVENT.mergeGroup,
      depth: SUITE_DEPTH.full,
      queueDepth: "thin",
      corpusRequired: true,
    }),
  ).toBe(true);
});

test("parity treats absent or false heavy-only input as ordinary event execution", () => {
  for (const event of [
    EVENT.pullRequest,
    EVENT.mergeGroup,
    EVENT.workflowDispatch,
  ]) {
    for (const heavyOnly of [undefined, false, true]) {
      const context = {
        event,
        depth: SUITE_DEPTH.full,
        ...(heavyOnly === undefined ? {} : { heavyOnly }),
      };
      expect(runsAtDepth("inputs.heavy_only == true", context)).toBe(
        heavyOnly === true,
      );
      expect(runsAtDepth("inputs.heavy_only != true", context)).toBe(
        heavyOnly !== true,
      );
      expect(
        runsAtDepth(
          "needs.ci-plan.outputs.heavy_web_build_required == 'true'",
          context,
        ),
      ).toBe(heavyOnly === true);
      expect(runsAtDepth(jobIf(ciJobs["heavy-web-build"]), context)).toBe(
        heavyOnly === true && event !== EVENT.pullRequest,
      );
    }
  }
  expect(() =>
    runsAtDepth("inputs.unknown == true", {
      event: EVENT.pullRequest,
      depth: SUITE_DEPTH.fast,
    }),
  ).toThrow("Unknown CI predicate context");
});

test("parity predicates follow GitHub precedence and reject malformed expressions", () => {
  const context = {
    event: EVENT.pullRequest,
    depth: SUITE_DEPTH.fast,
  } as const;
  for (const left of [true, false]) {
    for (const middle of [true, false]) {
      for (const right of [true, false]) {
        expect(runsAtDepth(`${left} || ${middle} && ${right}`, context)).toBe(
          left || (middle && right),
        );
        expect(
          runsAtDepth(`(${left} || ${middle}) && !${right}`, context),
        ).toBe((left || middle) && !right);
      }
    }
  }
  expect(() => runsAtDepth("true &&", context)).toThrow("expected a token");
  expect(() => runsAtDepth("(true", context)).toThrow("expected )");
  expect(() => runsAtDepth("true false", context)).toThrow("trailing tokens");
  expect(() => runsAtDepth("github.unknown == 'true'", context)).toThrow(
    "Unknown CI predicate context",
  );
});

test("property suites and their budgets select required PR checks", () => {
  for (const file of [
    "packages/property-testing/src/index.ts",
    "packages/property-testing/src/run-factor.ts",
    "packages/property-testing/src/preload.ts",
    "packages/property-testing/property-seeds.json",
    "packages/property-testing/src/index.test.ts",
    "scripts/prepare-maintenance-release.property.test.ts",
    "apps/api/src/handlers/case-law/judges/judge-name.property.test.ts",
    "turbo.json",
    "provenance/manifest.json",
  ]) {
    expect(requiresPackageChecks({ changed: [file] }), file).toBe(true);
  }
  for (const job of ["ci-tests", "ci-checks-policy", "ci-checks-rest"]) {
    expect(
      runsAtDepth(jobIf(ciJobs[job]), {
        event: EVENT.pullRequest,
        depth: SUITE_DEPTH.fast,
      }),
      job,
    ).toBe(true);
    expect(fastRequired, job).toContain(job);
    expect(
      evaluateResult({
        event: EVENT.pullRequest,
        results: { [job]: "skipped" },
      }),
      job,
    ).toBe(1);
  }
  const propertyGuard = jobSteps(ciJobs["ci-checks-rest"]).find(
    ({ name }) => name === "Property-test convention guard",
  );
  expect(propertyGuard?.if).toBe(
    `\${{ !cancelled() && steps.install.outcome == 'success' && (needs.ci-plan.outputs.package_checks_required == 'true') }}`,
  );
  const tests = jobSteps(ciJobs["ci-tests"]).find(
    ({ name }) => name === "Test API or rest",
  );
  expect(tests?.if).toContain(
    "needs.ci-plan.outputs.package_checks_required == 'true'",
  );
});

test("network-baseline PR coverage reuses the route-smoke profile and path scope", () => {
  for (const file of [
    "apps/web/src/routes/__root.tsx",
    "apps/web/e2e/network-baseline.json",
    "scripts/network-baseline-scope.ts",
    "scripts/network-baseline-scope.test.ts",
  ]) {
    expect(
      runSelector([file], ["route_smoke_required", "web_build_required"]),
      file,
    ).toEqual(["true", "true"]);
  }
  // Loose steps keep `env`, which jobSteps' strict schema drops.
  const network = v
    .parse(
      v.object({
        steps: v.array(v.looseObject({ name: v.optional(v.string()) })),
      }),
      ciJobs["route-smoke"],
    )
    .steps.find(({ name }) => name === "Check route network baseline");
  const step = v.parse(
    v.object({ env: v.record(v.string(), v.string()), run: v.string() }),
    network,
  );
  expect(step.env["E2E_EXECUTION_PROFILE"]).toBe("network-baseline");
  expect(step.run).toContain("route-smoke.spec.ts");
  expect(jobIf(ciJobs["route-smoke"])).toContain(
    "needs.ci-plan.outputs.route_smoke_required == 'true'",
  );
  expect(jobScopes["route-smoke"]).toBe("route_smoke_required");
  expect(fastRequired).not.toContain("route-smoke");
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "route-smoke": "skipped" },
    }),
  ).toBe(0);
});

test("the advisory base proof runs only for pull requests opting in with prove-fix", () => {
  const condition = jobIf(ciJobs["fix-tests-on-base"]);
  expect(fastRequired).not.toContain("fix-tests-on-base");
  for (const event of [
    EVENT.pullRequest,
    EVENT.mergeGroup,
    EVENT.workflowDispatch,
  ]) {
    for (const proveFix of [false, true]) {
      expect(
        runsAtDepth(condition, { event, depth: SUITE_DEPTH.fast, proveFix }),
      ).toBe(event === EVENT.pullRequest && proveFix);
    }
  }
});

test("the exact docs-only README change plans only Markdown checks in PRs and merge groups", () => {
  const outputs = [
    ...new Set([
      ...Object.values(jobScopes).filter(
        (scope): scope is string =>
          scope !== null && !COMPUTED_SCOPES.has(scope),
      ),
      "desktop_browser_required",
      ...Object.values(fastJobScopes),
      "docs_checks_required",
      "docs_changed_files",
    ]),
  ];
  for (const event of [EVENT.pullRequest, EVENT.mergeGroup]) {
    const depth =
      event === EVENT.pullRequest ? SUITE_DEPTH.fast : SUITE_DEPTH.full;
    const selected = runSelector(
      ["README.md", "apps/desktop/README.md"],
      outputs,
      depth,
      "false",
      event,
    );
    const plan = Object.fromEntries(
      outputs.map((name, index) => [name, selected.at(index) ?? ""]),
    );
    plan["ci_browser_required"] = browserPlanOutput({
      event,
      depth,
      desktopRequired: plan["desktop_browser_required"] ?? "",
      packageChecksRequired: plan["package_checks_required"] ?? "",
    });
    plan["pr_heavy_gate_required"] = heavyGatePlanOutput({ event, plan });
    expect(plan["package_checks_required"]).toBe("false");
    expect(plan["docs_checks_required"]).toBe("true");
    expect(JSON.parse(plan["docs_changed_files"] ?? "null")).toEqual([
      "README.md",
      "apps/desktop/README.md",
    ]);
    const values = {
      "github.event_name": event,
      "inputs.heavy_only": false,
      "inputs.pr_depth_only": false,
      "github.event.pull_request.labels.*.name": [],
      "needs.ci-plan.outputs.trusted": "true",
      "needs.ci-plan.outputs.run_required": "true",
      // An unlabelled pull request is unarmed; a merge group has no armed proof.
      "needs.ci-plan.outputs.heavy_proof": String(event === EVENT.mergeGroup),
      "needs.ci-plan.outputs.coverage_profile": "normal-v1",
      "needs.ci-plan.outputs.suite_depth": depth,
      "needs.ci-plan.outputs.queue_depth": "full",
      ...Object.fromEntries(
        Object.entries(plan).map(([name, value]) => [
          `needs.ci-plan.outputs.${name}`,
          value,
        ]),
      ),
    };
    const scheduled = gatedJobs.filter(
      (job) =>
        evaluate(jobIf(ciJobs[job]), {
          values,
          status: {
            failure: false,
            cancelled: false,
            always: true,
            success: true,
          },
        }) !== false,
    );
    // The quick checks carry the wall-clock expiry check, which runs on every
    // candidate, and the Markdown checks; the parser guard stays unplanned.
    const quickChecksJob =
      event === EVENT.pullRequest ? "pr-heavy-gate" : "ci-quick-checks";
    expect(scheduled).toEqual([quickChecksJob]);
    expect(resultJob.needs).toContain(quickChecksJob);
    if (event === EVENT.pullRequest) {
      expect(fastRequired).toContain(quickChecksJob);
    }
    const partSelected = (prefix: string) =>
      v
        .parse(
          v.object({
            steps: v.array(
              v.looseObject({ name: v.string(), if: v.optional(v.string()) }),
            ),
          }),
          ciJobs[quickChecksJob],
        )
        .steps.filter(({ name }) => name.startsWith(prefix))
        .map((step) =>
          evaluate(step.if ?? "true", {
            values: { ...values, "steps.install.outcome": "success" },
            status: {
              failure: false,
              cancelled: false,
              always: true,
              success: true,
            },
          }),
        );
    expect(partSelected("ci-checks-docs: ")).toEqual([true]);
    expect(partSelected("parser-version-guard: ")).toEqual([false]);
    expect(partSelected("dated-waiver-expiry: ")).toEqual([true, true, true]);
    expect(
      evaluateResult({
        event,
        suiteDepth: depth,
        results: Object.fromEntries(
          gatedJobs
            .filter((job) => !scheduled.includes(job))
            .map((job) => [job, "skipped"]),
        ),
        unplannedScopes: Object.keys(plan).filter(
          (scope) => plan[scope] !== "true",
        ),
      }),
    ).toBe(0);
    for (const outcome of ["failure", "cancelled", "skipped"] as const) {
      expect(
        evaluateResult({
          event,
          suiteDepth: depth,
          results: { [quickChecksJob]: outcome },
          unplannedScopes: Object.keys(plan).filter(
            (scope) => plan[scope] !== "true",
          ),
        }),
        `${event}/${outcome}`,
      ).toBe(1);
    }
  }
});

test("mixed documentation and code changes retain the complete code plan", () => {
  const outputs = [
    ...new Set([
      ...Object.values(jobScopes).filter(
        (scope): scope is string =>
          scope !== null && !COMPUTED_SCOPES.has(scope),
      ),
      "desktop_browser_required",
      ...Object.values(fastJobScopes),
      "docs_checks_required",
      "docs_changed_files",
    ]),
  ];
  for (const event of [EVENT.pullRequest, EVENT.mergeGroup]) {
    const depth =
      event === EVENT.pullRequest ? SUITE_DEPTH.fast : SUITE_DEPTH.full;
    const code = ["apps/api/src/index.ts"];
    const selected = runSelector(
      [...code, "README.md", "apps/desktop/README.md"],
      outputs,
      depth,
      "false",
      event,
    );
    expect(selected).toEqual(runSelector(code, outputs, depth, "false", event));
    const plan = Object.fromEntries(
      outputs.map((name, index) => [name, selected.at(index) ?? ""]),
    );
    plan["ci_browser_required"] = browserPlanOutput({
      event,
      depth,
      desktopRequired: plan["desktop_browser_required"] ?? "",
      packageChecksRequired: plan["package_checks_required"] ?? "",
    });
    plan["pr_heavy_gate_required"] = heavyGatePlanOutput({ event, plan });
    expect(plan["package_checks_required"]).toBe("true");
    expect(plan["docs_checks_required"]).toBe("false");
    if (event !== EVENT.mergeGroup) {
      continue;
    }
    const values = {
      ...heavyGateContext(event).values,
      "inputs.heavy_only": false,
      "inputs.pr_depth_only": false,
      "needs.ci-plan.outputs.trusted": "true",
      "needs.ci-plan.outputs.run_required": "true",
      "needs.ci-plan.outputs.coverage_profile": "normal-v1",
      "needs.ci-plan.outputs.suite_depth": depth,
      "needs.ci-plan.outputs.queue_depth": "full",
      ...Object.fromEntries(
        Object.entries(plan).map(([name, value]) => [
          `needs.ci-plan.outputs.${name}`,
          value,
        ]),
      ),
    };
    for (const [job, scope] of Object.entries(jobScopes)) {
      if (scope === "package_checks_required") {
        expect(
          evaluate(jobIf(ciJobs[job]), {
            values,
            status: {
              failure: false,
              cancelled: false,
              always: true,
              success: true,
            },
          }),
          job,
        ).toBe(true);
      }
    }
  }
});

test("documentation guards run independently of package checks", () => {
  const steps = jobSteps(ciJobs["ci-checks-policy"]);
  for (const name of [
    "Install dependencies",
    "Documentation source policy rule",
    "Instruction references",
  ]) {
    const step = steps.find((entry) => entry.name === name);
    expect(step?.if).not.toContain("package_checks_required");
    expect(step?.if).toContain(
      name === "Install dependencies"
        ? "steps.checkout.outcome == 'success'"
        : "steps.install.outcome == 'success'",
    );
  }
});

test("API test matrix omits unaffected API shards and keeps whole affected merge suites", () => {
  const web = planCiApiTests({
    event: "pull_request",
    scopeUnknown: false,
    testJobs: ["rest-web"],
    select: () => selectApiTestImpact({ changed: ["apps/web/src/page.tsx"] }),
  });
  expect(web.type).toBe("run");
  expect(web.type === "run" ? web.matrix.shard : []).toEqual(["rest-web"]);
  const queue = planCiApiTests({
    event: "merge_group",
    scopeUnknown: false,
    testJobs: ["rest-web"],
    select: () => ({ mode: "none", files: [], shards: 0 }),
  });
  expect(queue.type).toBe("run");
  expect(queue.type === "run" ? queue.matrix.shard : []).toEqual(["rest-web"]);
  expect(
    (() => {
      const plan = planCiApiTests({
        event: "merge_group",
        scopeUnknown: false,
        testJobs: FULL_TEST_JOB_SHARDS,
        select: () => {
          throw new Error("Merge API files must not be narrowed");
        },
      });
      return plan.type === "run" ? plan.matrix.shard : [];
    })(),
  ).toEqual(["api-1", "api-2", "api-3", "api-4", "api-5", "api-6", "rest-web"]);
  expect(workflow).toContain(
    `matrix: \${{ fromJSON(needs.ci-plan.outputs.ci_tests_matrix) }}`,
  );
  const planner = jobSteps(ciJobs["ci-plan"]).find(
    (step) => step.name === "Select affected API test files",
  );
  expect(planner?.run).toContain(
    "! timeout --kill-after=10s 120s bun scripts/ci-api-test-plan.ts; then",
  );
  expect(planner?.run).toContain("api_test_shards=6");
  expect(planner?.env?.["COMPARISON_BASE"]).toBe(
    `\${{ steps.changed-files.outputs.comparison_base }}`,
  );
  const runner = jobSteps(ciJobs["ci-tests"]).find(
    (step) => step.name === "Test API or rest",
  );
  expect(runner?.env?.["API_TEST_FILES"]).toBe(
    `\${{ needs.ci-plan.outputs.api_test_files }}`,
  );
  expect(runner?.env?.["TEST_SCOPE"]).toBe(
    `\${{ needs.ci-plan.outputs.test_scope }}`,
  );
  expect(runner?.run).not.toContain("scripts/test-scope.ts");
  expect(runner?.run).toContain('read -r -a args <<<"$TEST_SCOPE"');
  expect(
    v.parse(v.object({ needs: v.array(v.string()) }), ciJobs["ci-result"])
      .needs,
  ).toContain("ci-tests");
  expect(jobIf(ciJobs["ci-result"])).toBe("always()");
});

test("a crashed API planner widens the real workflow outputs", () => {
  const planner = jobSteps(ciJobs["ci-plan"]).find(
    (step) => step.name === "Select affected API test files",
  );
  const directory = mkdtempSync(nodePath.join(tmpdir(), "api-plan-fallback-"));
  const output = nodePath.join(directory, "output");
  try {
    const result = Bun.spawnSync(
      [
        "bash",
        "-e",
        "-c",
        `timeout() { shift 2; "$@"; }; bun() { echo invoked > "$PLANNER_CALLED"; return 1; }\n${planner?.run ?? panic("Missing API test planner")}`,
      ],
      {
        env: {
          PATH: Bun.env["PATH"] ?? "",
          GITHUB_OUTPUT: output,
          EVENT_NAME: "pull_request",
          PACKAGE_CHECKS_REQUIRED: "true",
          API_SCOPE_UNKNOWN: "false",
          PLANNER_CALLED: nodePath.join(directory, "called"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(nodePath.join(directory, "called"), "utf-8")).toBe(
      "invoked\n",
    );
    const values = readFileSync(output, "utf-8");
    expect(values).toContain(
      'ci_tests_matrix={"shard":["api-1","api-2","api-3","api-4","api-5","api-6","rest-web"]}',
    );
    expect(values).toContain("api_test_shards=6");
    expect(values).toContain("api_test_files=\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  {
    event: "pull_request",
    outcome: "failure",
    matrix: '{"shard":[]}',
    full: true,
  },
  { event: "pull_request", outcome: "success", matrix: "", full: true },
  {
    event: "merge_group",
    outcome: "success",
    matrix: '{"shard":[1]}',
    full: true,
  },
  { event: "push", outcome: "success", matrix: '{"shard":[1]}', full: true },
  {
    event: "workflow_dispatch",
    outcome: "success",
    matrix: '{"shard":[1]}',
    full: true,
  },
  {
    event: "pull_request",
    outcome: "success",
    matrix: '{"shard":[1]}',
    full: false,
  },
  {
    event: "pull_request",
    outcome: "success",
    matrix: '{"shard":[]}',
    full: false,
  },
])(
  "the e2e planner preserves full depth or selected PR legs: %j",
  ({ event, outcome, matrix, full }) => {
    const planner = jobSteps(ciJobs["ci-plan"]).find(
      (step) => step.name === "Plan changed PR e2e shards",
    );
    const directory = mkdtempSync(nodePath.join(tmpdir(), "e2e-plan-"));
    const output = nodePath.join(directory, "output");
    const selected = matrix === '{"shard":[1]}';
    const specs = selected ? '["apps/web/e2e/specs/guides.spec.ts"]' : "[]";
    try {
      const result = Bun.spawnSync(
        [
          "bash",
          "-e",
          "-c",
          `bun() {
          [[ "$*" == 'scripts/e2e-spec-shards-core.ts all' ]] || return 1
          printf '%s' '{"shard":[1,2,"network-baseline"]}'
        }
        ${planner?.run ?? panic("Missing e2e shard planner")}`,
        ],
        {
          env: {
            PATH: Bun.env["PATH"] ?? "",
            E2E_PRODUCTION_REQUIRED: "true",
            ROUTE_SMOKE_REQUIRED: "false",
            EVENT_NAME: event,
            GITHUB_OUTPUT: output,
            SELECTED_MATRIX: matrix,
            SELECTED_MODE: "selected",
            SELECTED_SPECS: specs,
            SELECTOR_OUTCOME: outcome,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const required = full || selected;
      expect(readFileSync(output, "utf-8")).toBe(
        [
          `matrix=${full ? '{"shard":[1,2,"network-baseline"]}' : matrix}`,
          `mode=${full ? "full" : "selected"}`,
          `specs=${full ? "[]" : specs}`,
          `selection_required=${required}`,
          `required=${required}`,
          "",
        ].join("\n"),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// The dedup drops a merge group's network-baseline leg only because route-smoke
// produces the same "network manifest matches the committed baseline" verdict;
// pin every link of that chain so neither side can drift alone.
test("a merge group that drops the network leg still runs the network manifest verdict", () => {
  const routeSmoke = v.parse(
    v.looseObject({
      if: v.string(),
      steps: v.array(
        v.looseObject({
          id: v.optional(v.string()),
          run: v.optional(v.string()),
          env: v.optional(v.record(v.string(), v.unknown())),
        }),
      ),
    }),
    ciJobs["route-smoke"],
  );
  expect(routeSmoke.if).toContain("github.event_name == 'merge_group'");
  expect(routeSmoke.if).toContain(
    "needs.ci-plan.outputs.route_smoke_required == 'true'",
  );
  const proof = routeSmoke.steps.find(({ id }) => id === "network-baseline");
  expect(proof?.run).toContain("route-smoke.spec.ts --project=route-smoke");
  expect(proof?.env?.["E2E_EXECUTION_PROFILE"]).toBe("network-baseline");
  // Comparison mode: a baseline write would skip the committed comparison.
  expect(proof?.env?.["E2E_NETWORK_BASELINE"]).toBeUndefined();
  // The planner keys the dedup on the same signal the route-smoke job runs on.
  const planOutputs = v.parse(
    v.looseObject({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  ).outputs;
  expect(planOutputs["route_smoke_required"]).toBe(
    `\${{ steps.changed-files.outputs.route_smoke_required }}`,
  );
  expect(workflow).toContain(
    `ROUTE_SMOKE_REQUIRED: \${{ steps.changed-files.outputs.route_smoke_required }}`,
  );
  const spec = readFileSync(
    new URL("../apps/web/e2e/specs/route-smoke.spec.ts", import.meta.url),
    "utf-8",
  );
  expect(spec).toContain(
    'test("network manifest matches the committed baseline"',
  );
});

test.each([
  {
    event: EVENT.mergeGroup,
    routeSmokeRequired: "true",
    expected: '{"shard":[1,2]}',
  },
  {
    event: EVENT.pullRequest,
    routeSmokeRequired: "true",
    expected: '{"shard":[1,2,"network-baseline"]}',
  },
])(
  "the e2e planner deduplicates the merge-group network proof: %j",
  ({ event, routeSmokeRequired, expected }) => {
    const planner = jobSteps(ciJobs["ci-plan"]).find(
      (step) => step.name === "Plan changed PR e2e shards",
    );
    const directory = mkdtempSync(nodePath.join(tmpdir(), "e2e-proof-plan-"));
    const output = nodePath.join(directory, "output");
    try {
      const result = Bun.spawnSync(
        [
          "bash",
          "-e",
          "-c",
          `bun() { printf '%s' '{"shard":[1,2,"network-baseline"]}'; }\n${planner?.run ?? panic("Missing e2e shard planner")}`,
        ],
        {
          env: {
            PATH: Bun.env["PATH"] ?? "",
            E2E_PRODUCTION_REQUIRED: "true",
            ROUTE_SMOKE_REQUIRED: routeSmokeRequired,
            EVENT_NAME: event,
            GITHUB_OUTPUT: output,
            SELECTED_MATRIX: "",
            SELECTED_MODE: "",
            SELECTED_SPECS: "",
            SELECTOR_OUTCOME: "skipped",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(output, "utf-8")).toContain(`matrix=${expected}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("nightly full tests use the shared full-depth shard plan and selection enters its cache key", () => {
  const nightly = readFileSync(
    new URL("../.github/workflows/nightly-test.yml", import.meta.url),
    "utf-8",
  );
  const steps = jobSteps(workflowJobs(nightly)["full-test"]);
  const full = steps.find((step) => step.name === "Full test suite");
  expect(nightly).toContain(
    `matrix: \${{ fromJSON(needs.full-test-plan.outputs.matrix) }}`,
  );
  expect(full?.run).toContain("scripts/test-shards.ts --filters");
  expect(full?.run).toContain("scripts/test-shards.ts --api-shard");
  expect(full?.run).toContain(
    `bun run test -- --concurrency=2 "\${shard_args[@]}"`,
  );
  expect(full?.env?.["TURBO_FORCE"]).toBe("true");
  expect(missingFullTestShards(nightly)).toEqual([]);
  const planner = jobSteps(workflowJobs(nightly)["full-test-plan"]).find(
    (step) => step.name === "Plan full test shards",
  );
  expect(planner?.run).toContain("scripts/api-test-shard-plan.ts");
  expect(nightly).not.toContain("API_TEST_FILES:");
  const turbo = readFileSync(
    new URL("../turbo.json", import.meta.url),
    "utf-8",
  );
  const tasks = v.parse(
    v.object({
      tasks: v.record(
        v.string(),
        v.looseObject({ env: v.optional(v.array(v.string())) }),
      ),
    }),
    Bun.JSONC.parse(turbo),
  ).tasks;
  expect(tasks["@stll/api#test"]?.env).toEqual(
    expect.arrayContaining(["API_TEST_SHARD", "API_TEST_FILES"]),
  );
});

test("the nightly shard census rejects a planted missing web suite", () => {
  const nightly = readFileSync(
    new URL("../.github/workflows/nightly-test.yml", import.meta.url),
    "utf-8",
  );
  const planted = nightly.replace(
    /\n {6}- name: Full web test suite\n[\s\S]*?(?=\n\n {2}# The production client build)/u,
    "",
  );
  expect(planted).not.toBe(nightly);
  expect(missingFullTestShards(planted)).toEqual(["rest-web/web"]);
});

test("API planning only loads dependencies after installation and emits install-free fallbacks", () => {
  const steps = jobSteps(ciJobs["ci-plan"]);
  const select = steps.find(
    (step) => step.name === "Select affected API test files",
  );
  expect(select?.if).toBe(
    "steps.completed-depth.outputs.run_required != 'false' && (github.event_name == 'pull_request' || github.event_name == 'merge_group') && steps.planner-deps.outcome == 'success' && steps.api-test-deps.outcome == 'success'",
  );
  const plan = steps.find(
    (step) => step.name === "Plan API test files and shards",
  );
  expect(plan?.run).toContain("bun scripts/api-test-shard-plan.ts");
  const directory = mkdtempSync(nodePath.join(tmpdir(), "api-plan-output-"));
  const output = nodePath.join(directory, "output");
  try {
    for (const [
      event,
      packages,
      unknown,
      selectedRequired,
      selected,
      shards,
      expected,
    ] of [
      ["pull_request", "false", "false", "", "", "", "0"],
      ["pull_request", "true", "false", "", "", "", "6"],
      // Without package checks no API test runs, even when the API scope is
      // unknown: ci_tests_required is the one gate of ci-tests.
      ["pull_request", "false", "true", "", "", "", "0"],
      ["merge_group", "true", "false", "", "", "", "6"],
      ["workflow_dispatch", "true", "false", "", "", "", "6"],
      [
        "pull_request",
        "true",
        "false",
        "true",
        '{"shard":["api-1","rest-web"]}',
        "1",
        "1",
      ],
      [
        "pull_request",
        "true",
        "false",
        "",
        '{"shard":["api-1","rest-web"]}',
        "1",
        "6",
      ],
    ]) {
      writeFileSync(output, "");
      const result = Bun.spawnSync(
        ["bash", "-e", "-c", plan?.run ?? panic("Missing output planner")],
        {
          env: {
            PATH: Bun.env["PATH"] ?? "",
            GITHUB_OUTPUT: output,
            EVENT_NAME: event,
            PACKAGE_CHECKS_REQUIRED: packages,
            API_SCOPE_UNKNOWN: unknown,
            SELECTED_REQUIRED: selectedRequired,
            SELECTED_MATRIX: selected,
            SELECTED_SHARDS: shards,
            SELECTED_FILES: selected ? "src/a.test.ts\nsrc/b.test.ts" : "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const values = readFileSync(output, "utf-8");
      expect(values).toContain(`api_test_shards=${String(expected)}\n`);
      if (selectedRequired) {
        expect(values).toContain(`ci_tests_required=${selectedRequired}\n`);
        expect(values).toContain(`ci_tests_matrix=${String(selected)}\n`);
        expect(values).toContain(
          "api_test_files<<API_TEST_FILES_END\nsrc/a.test.ts\nsrc/b.test.ts\nAPI_TEST_FILES_END\n",
        );
      } else if (packages !== "true") {
        expect(values).toContain("ci_tests_required=false\n");
        expect(values).toContain('ci_tests_matrix={"shard":["rest-web"]}\n');
      } else if (selected) {
        expect(values).toContain("ci_tests_required=true\n");
        expect(values).toContain(
          'ci_tests_matrix={"shard":["api-1","api-2","api-3","api-4","api-5","api-6","rest-web"]}\n',
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Postgres plans are visible on PRs while execution requires explicit opt-in", () => {
  const steps = jobSteps(ciJobs["ci-plan"]);
  const planner = steps.find(
    (step) => step.name === "Select affected Postgres test files",
  );
  const runner = jobSteps(ciJobs["postgres-service-suites"]).find(
    (step) => step.name === "Run Postgres-gated API suites",
  );
  const runnerSelection =
    runner?.env?.["CI_POSTGRES_TEST_SELECTION"] ??
    panic("Missing Postgres selection wiring");
  const jobCondition = jobIf(ciJobs["postgres-service-suites"]);
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  const eligibility =
    plan.outputs["postgres_service_suites_required"] ??
    panic("Missing Postgres service eligibility output");
  for (const mode of ["selected", "all", "none"] as const) {
    const selection = JSON.stringify(
      mode === "selected"
        ? { mode, files: ["src/synthetic.db.test.ts"] }
        : { mode },
    );
    for (const event of [
      EVENT.mergeGroup,
      EVENT.workflowDispatch,
      EVENT.pullRequest,
    ]) {
      for (const prSwitch of ["", "off", "on"]) {
        const enabled = event === EVENT.pullRequest && prSwitch === "on";
        const values = {
          "github.event_name": event,
          "vars.CI_POSTGRES_PR_SELECTION": prSwitch,
          "steps.completed-depth.outputs.run_required": "true",
          "steps.planner-deps.outcome": "success",
          "steps.api-test-deps.outcome": "success",
          "needs.ci-plan.outputs.run_required": "true",
          "needs.ci-plan.outputs.queue_depth": "full",
          "needs.ci-plan.outputs.service_suites_required": "true",
          "needs.ci-plan.outputs.package_checks_required": "true",
          "needs.ci-plan.outputs.service_suites_pr_required": "true",
          "needs.ci-plan.outputs.corpus_suites_required": "false",
          "needs.ci-plan.outputs.postgres_suites_required": "true",
          "needs.ci-plan.outputs.trusted": "true",
          "needs.ci-plan.outputs.heavy_proof": "true",
          "needs.ci-plan.outputs.armed_delta": "false",
          "needs.ci-plan.outputs.suite_depth":
            event === EVENT.pullRequest ? "fast" : "full",
          "needs.ci-plan.outputs.postgres_pr_required": String(enabled),
          "needs.ci-plan.outputs.postgres_test_selection": selection,
        };
        const eligible = evaluate(eligibility, {
          values: {
            ...values,
            "steps.depth.outputs.suite_depth":
              values["needs.ci-plan.outputs.suite_depth"],
            "steps.depth.outputs.queue_depth":
              values["needs.ci-plan.outputs.queue_depth"],
            ...Object.fromEntries(
              Object.entries(values).map(([key, value]) => [
                key.replace(
                  "needs.ci-plan.outputs.",
                  "steps.changed-files.outputs.",
                ),
                value,
              ]),
            ),
          },
        });
        const jobValues = {
          ...values,
          "needs.ci-plan.outputs.postgres_service_suites_required": v.parse(
            v.boolean(),
            eligible,
          )
            ? "true"
            : "false",
        };
        expect(eligible).toBe(event !== EVENT.pullRequest || enabled);
        expect(evaluate(planner?.if ?? "false", { values })).toBe(
          event === EVENT.mergeGroup || event === EVENT.pullRequest,
        );
        expect(
          evaluate(jobCondition, {
            values: {
              ...jobValues,
              "needs.ci-plan.result": "success",
              "needs.pr-heavy-gate.result":
                event === EVENT.pullRequest ? "success" : "skipped",
            },
            status: { cancelled: false },
          }),
        ).toBe(event !== EVENT.pullRequest || enabled);
        expect(evaluate(runner?.if ?? "false", { values })).toBe(
          event !== EVENT.pullRequest || prSwitch === "on",
        );
        expect(evaluate(runnerSelection, { values })).toBe(
          event === EVENT.mergeGroup || enabled ? selection : '{"mode":"all"}',
        );
        expect(
          evaluate(runnerSelection, {
            values: {
              ...values,
              "needs.ci-plan.outputs.postgres_test_selection": "",
            },
          }),
        ).toBe('{"mode":"all"}');
      }
    }
  }
  expect(planner?.run).toContain('postgres_test_selection={"mode":"all"}');
  // The opt-in requires the suites on the armed run; an unarmed push may
  // skip them with the other queue-only suites.
  for (const armed of [true, false]) {
    for (const result of ["success", "skipped", "failure"]) {
      expect(
        evaluateResult({
          event: EVENT.pullRequest,
          results: { "postgres-service-suites": result },
          plannedOutputs: {
            postgres_pr_required: "true",
            heavy_proof: String(armed),
          },
        }),
        `${armed}/${result}`,
      ).toBe(result === "success" || (!armed && result === "skipped") ? 0 : 1);
    }
  }
});

test("Postgres planning generates ignored runtime inputs and widens when any stage fails", () => {
  const planner = jobSteps(ciJobs["ci-plan"]).find(
    (step) => step.name === "Select affected Postgres test files",
  );
  const commands = [
    "--cwd=packages/cli run codegen:runtime",
    "--cwd=apps/api run generate:capability-runtime",
    "scripts/ci-postgres-test-plan.ts",
  ];
  const directory = mkdtempSync(
    nodePath.join(tmpdir(), "postgres-runtime-plan-"),
  );
  try {
    for (const failedCommand of ["", ...commands]) {
      const output = nodePath.join(directory, "output");
      const trace = nodePath.join(directory, "trace");
      writeFileSync(output, "");
      writeFileSync(trace, "");
      const result = Bun.spawnSync({
        cmd: [
          "bash",
          "-e",
          "-c",
          `timeout() { shift 2; "$@"; }
bun() {
  printf '%s\\n' "$*" >> "$TRACE"
  if [[ "$*" == "$FAILED_COMMAND" ]]; then return 1; fi
  if [[ "$*" == scripts/ci-postgres-test-plan.ts ]]; then
    printf '%s\\n' 'postgres_test_selection={"mode":"selected","files":["src/db.test.ts"]}' >> "$GITHUB_OUTPUT"
  fi
}
${planner?.run ?? panic("Missing Postgres planner")}`,
        ],
        env: {
          PATH: process.env["PATH"] ?? "",
          TRACE: trace,
          FAILED_COMMAND: failedCommand,
          GITHUB_OUTPUT: output,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const invoked = readFileSync(trace, "utf-8").trim().split("\n");
      expect(invoked).toEqual(
        failedCommand === ""
          ? commands
          : commands.slice(0, commands.indexOf(failedCommand) + 1),
      );
      expect(readFileSync(output, "utf-8")).toContain(
        failedCommand === "" ? '"mode":"selected"' : '"mode":"all"',
      );
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("full Postgres failures trigger selector replay only on main-heavy", () => {
  const steps = jobSteps(ciJobs["postgres-service-suites"]);
  const runner = steps.find(
    (step) => step.name === "Run Postgres-gated API suites",
  );
  const missCheck = steps.find(
    (step) => step.name === "Check full Postgres failures for selector misses",
  );
  expect(runner?.run).toContain("--reporter=junit");
  expect(runner?.run).toContain("postgres-tests.xml");
  expect(missCheck?.env?.["POSTGRES_JUNIT_FILE"]).toContain(
    "postgres-tests.xml",
  );
  expect(missCheck?.run).toContain("bun scripts/ci-postgres-selector-miss.ts");
  for (const heavyOnly of [false, true]) {
    for (const outcome of ["success", "failure", "skipped"]) {
      for (const cancelled of [false, true]) {
        expect(
          evaluate(missCheck?.if ?? "false", {
            values: {
              "inputs.heavy_only": heavyOnly,
              "inputs.pr_depth_only": false,
              "steps.postgres-tests.outcome": outcome,
            },
            status: { always: true, success: false, failure: true, cancelled },
          }),
        ).toBe(heavyOnly && outcome === "failure" && !cancelled);
      }
    }
  }
  const summary = jobSteps(ciJobs["ci-plan"]).find(
    (step) => step.name === "Summarize Postgres test selection",
  );
  expect(summary?.run).toContain("GITHUB_STEP_SUMMARY");
  expect(summary?.run).toContain('"full"');
  expect(summary?.env?.["SELECTION"]).toContain(
    "steps.postgres-test-plan.outputs.postgres_test_selection",
  );
  expect(summary?.env?.["REASON"]).toContain(
    "steps.postgres-test-plan.outputs.postgres_selection_reason",
  );
});

type BrowserPlanOptions = {
  event: Event | "push";
  depth: SuiteDepth;
  desktopRequired: string;
  runRequired?: string;
  trusted?: string;
  queueDepth?: string;
  packageChecksRequired?: string;
  browserScopeRequired?: string;
};
type HeavyGatePlanOptions = {
  event: Event;
  /** Selector outputs by name, as the changed-files step publishes them. */
  plan: Record<string, string>;
};
// The gate scope of a code run that found no reusable evidence.
const heavyGatePlanOutput = ({ event, plan }: HeavyGatePlanOptions) => {
  const { outputs } = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  // GitHub publishes a boolean output as its string form.
  return String(
    v.parse(
      v.boolean(),
      evaluate(outputs["pr_heavy_gate_required"] ?? "", {
        values: {
          "github.event_name": event,
          "steps.completed-depth.outputs.run_required": "true",
          "steps.completed-depth.outputs.armed": "true",
          "steps.completed-depth.outputs.pr_heavy_suites": "run",
          "steps.changed-files.outputs.package_checks_required":
            plan["package_checks_required"] ?? "",
          "steps.changed-files.outputs.collab_redis_required":
            plan["collab_redis_required"] ?? "",
          "steps.e2e-pr-plan.outputs.selection_required":
            plan["browser_spec_selection_required"] ?? "",
          "steps.changed-files.outputs.e2e_landing_required":
            plan["e2e_landing_required"] ?? "",
        },
      }),
    ),
  );
};

const browserPlanOutput = ({
  event,
  depth,
  desktopRequired,
  runRequired = "true",
  trusted = "true",
  queueDepth = "full",
  packageChecksRequired = "true",
  browserScopeRequired = "true",
}: BrowserPlanOptions) => {
  const { outputs } = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  return v.parse(
    v.picklist(["true", "false"]),
    evaluate(outputs["ci_browser_required"] ?? "", {
      values: {
        "github.event_name": event,
        "steps.completed-depth.outputs.run_required": runRequired,
        "steps.completed-depth.outputs.normal_reused": "",
        "steps.check.outputs.trusted": trusted,
        "steps.changed-files.outputs.desktop_browser_required": desktopRequired,
        "steps.changed-files.outputs.ci_browser_scope_required":
          browserScopeRequired,
        "steps.changed-files.outputs.package_checks_required":
          packageChecksRequired,
        "steps.depth.outputs.suite_depth": depth,
        "steps.depth.outputs.queue_depth": queueDepth,
      },
    }),
  );
};

test("Playwright image-only changes admit browser suites in merge groups", () => {
  for (const file of [
    "scripts/ci-service-images.ts",
    "scripts/ci-service-images.json",
  ]) {
    const [browserScopeRequired, desktopRequired, packageChecksRequired] =
      runSelector(
        [file],
        [
          "ci_browser_scope_required",
          "desktop_browser_required",
          "package_checks_required",
        ],
        SUITE_DEPTH.full,
        "false",
        EVENT.mergeGroup,
      );
    expect(browserScopeRequired, file).toBe("true");
    const planned = browserPlanOutput({
      event: EVENT.mergeGroup,
      depth: SUITE_DEPTH.full,
      desktopRequired: desktopRequired ?? panic("Missing desktop scope"),
      packageChecksRequired:
        packageChecksRequired ?? panic("Missing package scope"),
      browserScopeRequired:
        browserScopeRequired ?? panic("Missing browser scope"),
    });
    expect(planned, file).toBe("true");
    const gate = heavyGateContext(EVENT.mergeGroup);
    expect(
      evaluate(jobIf(ciJobs["ci-browser"]), {
        ...gate,
        values: {
          ...gate.values,
          "inputs.pr_depth_only": false,
          "needs.ci-plan.outputs.ci_browser_required": planned,
          "needs.ci-plan.outputs.run_required": "true",
          "needs.ci-plan.outputs.coverage_profile": "normal-v1",
        },
      }),
      file,
    ).toBe(true);
  }
});

test("browser scope vetoes otherwise eligible execution", () => {
  for (const event of [
    EVENT.pullRequest,
    EVENT.mergeGroup,
    EVENT.workflowDispatch,
  ]) {
    const eligible = {
      event,
      depth: SUITE_DEPTH.full,
      desktopRequired: "true",
    };
    expect(
      browserPlanOutput({ ...eligible, browserScopeRequired: "true" }),
      event,
    ).toBe("true");
    const planned = browserPlanOutput({
      ...eligible,
      browserScopeRequired: "false",
    });
    expect(planned, event).toBe("false");
    expect(
      evaluate(jobIf(ciJobs["ci-browser"]), {
        values: {
          "needs.ci-plan.outputs.ci_browser_required": planned,
          "needs.ci-plan.outputs.run_required": "true",
          "needs.ci-plan.outputs.coverage_profile": "normal-v1",
        },
      }),
      event,
    ).toBe(false);
  }
});

test("Legal Atlas scope deadlines conservatively select the image after timeout or kill", () => {
  const { steps } = v.parse(
    v.object({
      steps: v.array(
        v.object({
          id: v.optional(v.string()),
          run: v.optional(v.string()),
          if: v.optional(v.string()),
        }),
      ),
    }),
    ciJobs["ci-plan"],
  );
  const step = steps.find(({ id }) => id === "legal-atlas-scope");
  const condition = v.parse(v.string(), step?.if);
  for (const runRequired of ["true", "false"]) {
    expect(
      evaluate(condition, {
        values: {
          "steps.completed-depth.outputs.run_required": runRequired,
          "steps.planner-deps.outcome": "success",
          "steps.api-test-deps.outcome": "success",
          "steps.changed-files.outputs.legal_atlas_image_required": "true",
        },
      }),
      runRequired,
    ).toBe(runRequired === "true");
  }
  const script = v.parse(v.string(), step?.run);
  const fixture = mkdtempSync(nodePath.join(tmpdir(), "atlas-scope-deadline-"));
  try {
    const bin = nodePath.join(fixture, "bin");
    mkdirSync(bin);
    writeFileSync(
      nodePath.join(fixture, "api-test-changed-paths"),
      "apps/api/src/handlers/health.ts\0",
    );
    const timeout = nodePath.join(bin, "timeout");
    writeFileSync(
      timeout,
      `#!/bin/sh
[ "$1" = --kill-after=10s ] && [ "$2" = 120s ] || exit 64
shift 2
if [ "$TIMEOUT_FIXTURE" != 0 ]; then exit "$TIMEOUT_FIXTURE"; fi
exec "$@"
`,
    );
    const bun = nodePath.join(bin, "bun");
    writeFileSync(
      bun,
      `#!/bin/sh
[ "$1" = scripts/legal-atlas-image-scope.ts ] || exit 65
printf 'false\\n'
`,
    );
    chmodSync(timeout, 0o700);
    chmodSync(bun, 0o700);
    const output = nodePath.join(fixture, "output");
    const run = (program: string, outcome: string) => {
      writeFileSync(output, "");
      const result = Bun.spawnSync(["/bin/bash", "-euc", program], {
        cwd: fixture,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          RUNNER_TEMP: fixture,
          GITHUB_OUTPUT: output,
          TIMEOUT_FIXTURE: outcome,
        },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return readFileSync(output, "utf-8");
    };
    for (const outcome of ["0", "124", "137"]) {
      expect(run(script, outcome), outcome).toBe(
        `api_source_required=${outcome !== "0"}\n`,
      );
    }
    const unbounded = script.replace("timeout --kill-after=10s 120s ", "");
    expect(unbounded).not.toBe(script);
    expect(run(unbounded, "124")).toBe("api_source_required=false\n");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Legal Atlas API source scope vetoes otherwise eligible execution", () => {
  const { outputs } = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  for (const apiSourceRequired of ["true", "false", ""]) {
    const planned = v.parse(
      v.boolean(),
      evaluate(outputs["legal_atlas_image_required"] ?? "", {
        values: {
          "steps.changed-files.outputs.legal_atlas_image_required": "true",
          "steps.legal-atlas-scope.outputs.api_source_required":
            apiSourceRequired,
        },
      }),
    );
    const expected = apiSourceRequired !== "false";
    expect(planned, apiSourceRequired).toBe(expected);
    expect(
      evaluate(jobIf(ciJobs["legal-atlas-image"]), {
        values: {
          "inputs.pr_depth_only": false,
          "github.event_name": EVENT.mergeGroup,
          "needs.ci-plan.outputs.run_required": "true",
          "needs.ci-plan.outputs.heavy_proof": "true",
          "needs.ci-plan.outputs.trusted": "true",
          "needs.ci-plan.outputs.legal_atlas_image_required": String(planned),
          "needs.ci-plan.outputs.suite_depth": SUITE_DEPTH.full,
        },
      }),
      apiSourceRequired,
    ).toBe(expected);
  }
});

// timeout: Executes the bounded event/depth/browser matrix in real Bash processes.
test("browser planning, scheduling and result gates agree across events and depths", () => {
  const cases = (
    [
      EVENT.workflowDispatch,
      "push",
      EVENT.mergeGroup,
      EVENT.pullRequest,
    ] as const
  ).flatMap((event) =>
    [SUITE_DEPTH.fast, SUITE_DEPTH.full].flatMap((depth) =>
      ["true", "false"].flatMap((desktopRequired) =>
        ["true", "false"].flatMap((trusted) =>
          ["true", "false"].flatMap((runRequired) =>
            ["full", "thin"].map((queueDepth) => ({
              event,
              depth,
              desktopRequired,
              trusted,
              runRequired,
              queueDepth,
            })),
          ),
        ),
      ),
    ),
  );
  for (const options of cases.flatMap((testCase) =>
    ["true", "false"].map((packageChecksRequired) => ({
      ...testCase,
      packageChecksRequired,
    })),
  )) {
    const planned = browserPlanOutput(options);
    const expected =
      options.runRequired === "true" &&
      options.packageChecksRequired === "true" &&
      (options.trusted === "true" ||
        options.event === EVENT.workflowDispatch) &&
      (options.event === EVENT.pullRequest
        ? options.desktopRequired === "true"
        : options.depth === SUITE_DEPTH.full);
    expect(planned, JSON.stringify(options)).toBe(expected ? "true" : "false");
    const gate = heavyGateContext(options.event);
    expect(
      evaluate(jobIf(ciJobs["ci-browser"]), {
        ...gate,
        values: {
          ...gate.values,
          "needs.ci-plan.outputs.ci_browser_required": planned,
          "needs.ci-plan.outputs.coverage_profile": "normal-v1",
        },
      }),
      JSON.stringify(options),
    ).toBe(expected);
  }
  expectResultGates(
    (
      [
        EVENT.workflowDispatch,
        "push",
        EVENT.mergeGroup,
        EVENT.pullRequest,
      ] as const
    ).flatMap((event) =>
      [SUITE_DEPTH.fast, SUITE_DEPTH.full].flatMap((depth) =>
        ["true", "false"].flatMap((desktopRequired) => {
          const planned = browserPlanOutput({ event, depth, desktopRequired });
          return ["success", "skipped", "failure"].map((result) => ({
            label: `${event} ${depth} desktop=${desktopRequired} browser=${result}`,
            options: {
              event,
              suiteDepth: depth,
              results: { "ci-browser": result },
              plannedOutputs: { ci_browser_required: planned },
            },
            exitCode:
              (event === EVENT.mergeGroup && depth === SUITE_DEPTH.fast) ||
              result === "failure" ||
              (planned === "true" && result === "skipped")
                ? 1
                : 0,
          }));
        }),
      ),
    ),
  );
}, 30_000);

test("untrusted PRs skip browser CI while the result gate preserves its trust failure", () => {
  const cases = [SUITE_DEPTH.fast, SUITE_DEPTH.full].flatMap((depth) =>
    ["true", "false"].map((desktopRequired) => ({
      depth,
      planned: browserPlanOutput({
        event: EVENT.pullRequest,
        depth,
        desktopRequired,
        trusted: "false",
      }),
    })),
  );
  for (const { planned } of cases) {
    expect(planned).toBe("false");
    expect(
      evaluate(jobIf(ciJobs["ci-browser"]), {
        values: {
          "needs.ci-plan.outputs.ci_browser_required": planned,
          "needs.ci-plan.outputs.run_required": "true",
          "needs.ci-plan.outputs.coverage_profile": "normal-v1",
        },
      }),
    ).toBe(false);
  }
  for (const { exitCode, stdout } of evaluateResults(
    cases,
    ({ depth, planned }) => ({
      event: EVENT.pullRequest,
      suiteDepth: depth,
      trusted: "false",
      results: { "ci-browser": "skipped" },
      plannedOutputs: { ci_browser_required: planned },
    }),
  )) {
    expect(exitCode).toBe(1);
    expect(stdout).toContain("failed the trust check");
    expect(stdout).not.toContain("planned, skipped");
  }
});

test("a planted desktop path plans the PR desktop browser leg while unrelated paths skip it", () => {
  const root = nodePath.resolve(import.meta.dirname, "..");
  const directory = mkdtempSync(
    nodePath.join(root, "apps/desktop/.ci-browser-scope-"),
  );
  const planted = repoRelativePath(
    root,
    nodePath.join(directory, "planted.unclassified"),
  );
  writeFileSync(
    nodePath.join(directory, "planted.unclassified"),
    "new desktop input",
  );
  try {
    for (const [file, expected] of [
      [planted, "true"],
      ["apps/api/src/unrelated.ts", "false"],
    ] as const) {
      const required = runSelector([file], ["desktop_browser_required"]).at(0);
      if (required === undefined) {
        panic("Desktop scope selector returned no value");
      }
      expect(required).toBe(expected);
      for (const runRequired of ["true", "false"]) {
        const planned = browserPlanOutput({
          event: EVENT.pullRequest,
          depth: SUITE_DEPTH.fast,
          desktopRequired: required,
          runRequired,
        });
        expect(planned).toBe(
          expected === "true" && runRequired === "true" ? "true" : "false",
        );
        const gate = heavyGateContext(EVENT.pullRequest);
        expect(
          evaluate(jobIf(ciJobs["ci-browser"]), {
            ...gate,
            values: {
              ...gate.values,
              "needs.ci-plan.outputs.ci_browser_required": planned,
              "needs.ci-plan.outputs.coverage_profile": "normal-v1",
            },
          }),
        ).toBe(planned === "true");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  expect(fastJobScopes).not.toHaveProperty("ci-browser");
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "ci-browser": "skipped" },
    }),
  ).toBe(1);
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "ci-browser": "skipped" },
      unplannedScopes: ["ci_browser_required"],
    }),
  ).toBe(0);
});

test("Postgres PR required checks follow trust, run eligibility and the general opt-in", () => {
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  for (const trusted of ["true", "false"]) {
    for (const runRequired of ["true", "false"]) {
      for (const prSwitch of ["on", "off", ""]) {
        for (const scope of ["true", "false"]) {
          const enabled =
            trusted === "true" &&
            runRequired === "true" &&
            prSwitch === "on" &&
            scope === "true";
          expect(
            evaluate(plan.outputs["postgres_pr_required"] ?? "", {
              values: {
                "github.event_name": EVENT.pullRequest,
                "vars.CI_POSTGRES_PR_SELECTION": prSwitch,
                "steps.completed-depth.outputs.run_required": runRequired,
                "steps.check.outputs.trusted": trusted,
                "steps.changed-files.outputs.service_suites_pr_required": scope,
              },
            }),
          ).toBe(enabled);
        }
      }
    }
  }
});

// Armed heavy proof: the queue-only suites move into the pull request run
// once it is armed for merge, and a merge group skips them only for a head
// that carries that proof.
const heavyProofList = v.parse(
  v.array(v.string()),
  JSON.parse(resultStep.env["HEAVY_PROOF_JOBS"] ?? ""),
);
const mergeGroupHeavyKeep = v.parse(
  v.array(v.string()),
  JSON.parse(resultStep.env["MERGE_GROUP_HEAVY_KEEP"] ?? ""),
);
const LEGACY_QUEUE_ONLY = "github.event_name != 'pull_request' && (";
const armedRuns = (
  condition: string,
  event: Event,
  heavyProof: "true" | "false",
) =>
  v.parse(
    v.boolean(),
    evaluateExpression(condition, {
      values: {
        "github.event_name": event,
        "github.event.action": "synchronize",
        "github.event.pull_request.draft": false,
        // A manual proof of the queue-only suites is a heavy dispatch.
        "inputs.heavy_only": event === EVENT.workflowDispatch,
        "inputs.pr_depth_only": false,
        "needs.ci-plan.outputs.heavy_proof": heavyProof,
        "needs.ci-plan.outputs.armed_delta":
          event === EVENT.pullRequest && heavyProof === "true"
            ? "true"
            : "false",
        "needs.ci-plan.outputs.run_required": "true",
        "needs.ci-plan.outputs.trusted": "true",
        "needs.ci-plan.outputs.suite_depth":
          event === EVENT.pullRequest ? SUITE_DEPTH.fast : SUITE_DEPTH.full,
        "needs.ci-plan.outputs.queue_depth":
          event === EVENT.mergeGroup ? "thin" : "full",
        "needs.ci-plan.outputs.heavy_web_build_required": "false",
        "vars.CI_POSTGRES_PR_SELECTION": "on",
        "vars.QUEUE_BROWSER_SUITES": "",
        "github.event.pull_request.labels.*.name": [],
        "needs.ci-plan.outputs.coverage_profile": "normal-v1",
        "needs.ci-plan.outputs.pilot_fast_jobs": "[]",
      },
      status: { always: true, success: true, failure: false, cancelled: false },
      fallback: (path) => {
        if (path.startsWith("needs.ci-plan.outputs.")) {
          return "true";
        }
        if (/^needs\.[\w-]+\.result$/u.test(path)) {
          // e2e-report runs only after a browser suite failed.
          return path.includes("e2e-") ? "failure" : "success";
        }
        throw new TypeError(`Unknown CI predicate context: ${path}`);
      },
    }),
  );

test("every queue-only job follows the armed proof and skips proven merge groups unless kept", () => {
  const gated = heavyProofJobs({ jobs: ciJobs });
  expect(gated.length).toBeGreaterThan(0);
  for (const [key, policy] of Object.entries(eventPolicies.jobs)) {
    if (!key.startsWith("ci.yml/")) {
      continue;
    }
    const job = key.slice("ci.yml/".length);
    expect(policy === "armed", job).toBe(gated.includes(job));
    if (policy === "armed") {
      expect(jobIf(ciJobs[job]), job).not.toContain(LEGACY_QUEUE_ONLY);
    }
  }
  expect(heavyProofList.toSorted()).toEqual(
    gated.filter((job) => resultJob.needs.includes(job)).toSorted(),
  );
  expect(mergeGroupHeavyKeep.toSorted()).toEqual(
    Object.keys(MERGE_GROUP_HEAVY_KEEP).toSorted(),
  );
  for (const [job, reason] of Object.entries(MERGE_GROUP_HEAVY_KEEP)) {
    expect(gated, job).toContain(job);
    expect(reason.trim().length, job).toBeGreaterThan(0);
  }
  for (const job of gated) {
    const condition = jobIf(ciJobs[job]);
    expect(condition, job).toContain(HEAVY_PROOF_GATE);
    const kept = Object.hasOwn(MERGE_GROUP_HEAVY_KEEP, job);
    expect(armedRuns(condition, EVENT.pullRequest, "false"), job).toBe(false);
    expect(armedRuns(condition, EVENT.pullRequest, "true"), job).toBe(true);
    expect(armedRuns(condition, EVENT.mergeGroup, "true"), job).toBe(true);
    expect(armedRuns(condition, EVENT.mergeGroup, "false"), job).toBe(kept);
    expect(armedRuns(condition, EVENT.workflowDispatch, "true"), job).toBe(
      job !== "pr-heavy-gate" && job !== "web-build",
    );
  }
});

test("armed reuse covers every selected queue-only suite of the group", () => {
  const plan = v.parse(
    v.object({
      outputs: v.record(v.string(), v.string()),
      steps: v.array(v.unknown()),
    }),
    ciJobs["ci-plan"],
  );
  expect(plan.outputs["heavy_proof"]).toBe(
    ["$", "{{ steps.suites.outputs.heavy_proof }}"].join(""),
  );
  const script = v.parse(
    v.object({ run: v.string() }),
    flattenWorkflowSteps(plan.steps).find((step) => step["id"] === "suites"),
  ).run;
  const complete = {
    proven: ["mobile-build"],
    planned: "true",
    required: ["mobile-build"],
    scopes: { "mobile-build": "mobile_build_required" },
    expected: "false",
  };
  for (const { proven, planned, required, scopes, expected } of [
    complete,
    { ...complete, proven: [], expected: "true" },
    { ...complete, proven: [], planned: "false" },
    {
      ...complete,
      required: ["mobile-build", "windows-scripts"],
      expected: "true",
    },
    { ...complete, scopes: { "mobile-build": true }, expected: "true" },
    {
      ...complete,
      scopes: { "mobile-build": "unknown_required" },
      expected: "true",
    },
  ]) {
    const directory = mkdtempSync(nodePath.join(tmpdir(), "armed-coverage-"));
    try {
      const output = nodePath.join(directory, "output");
      const child = Bun.spawnSync(["bash", "-euc", script], {
        env: {
          PATH: Bun.env["PATH"] ?? "",
          GITHUB_OUTPUT: output,
          RUN_REQUIRED: "true",
          NORMAL_REUSED: "false",
          SUITE_DEPTH: "full",
          EVENT_NAME: "merge_group",
          ARMED_PROOF: "complete",
          HEAVY_PROOF_JOBS: JSON.stringify(required),
          ARMED_PROOF_JOBS: JSON.stringify(proven),
          ARMED_JOB_SCOPES: JSON.stringify(scopes),
          CHANGED_SCOPE: JSON.stringify({ mobile_build_required: planned }),
          MERGE_GROUP_HEAVY_KEEP: "[]",
        },
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(readFileSync(output, "utf-8")).toContain(
        `heavy_proof=${expected}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("the armed label starts a proof run without metadata mirroring", () => {
  // The ci-plan job name classifies a run as code or metadata; a metadata
  // run mirrors the newest code run's ci-result.
  const planJob = v.parse(v.object({ name: v.string() }), ciJobs["ci-plan"]);
  const planName = (action: string, label: string) =>
    evaluateExpression(bareExpression(planJob.name), {
      values: {
        "github.event_name": "pull_request",
        "github.event.action": action,
        "github.event.label.name": label,
      },
    });
  expect(planName("labeled", ARMED_LABEL)).toBe("ci-plan");
  expect(planName("unlabeled", ARMED_LABEL)).toBe("ci-plan");
  expect(planName("labeled", "prove-fix")).toBe("ci-plan");
  expect(planName("labeled", "other")).toBe("ci-metadata-plan");
  // auto_merge_enabled starts the armed suites, so it is a code run too.
  expect(planName("auto_merge_enabled", "")).toBe("ci-plan");
  const lookup = v
    .parse(
      v.object({
        steps: v.array(
          v.looseObject({
            id: v.optional(v.string()),
            with: v.optional(v.looseObject({ script: v.optional(v.string()) })),
          }),
        ),
      }),
      ciJobs["ci-plan"],
    )
    .steps.find((step) => step.id === "completed-depth")?.with?.script;
  expect(lookup).toContain(`const ARMED_LABEL = "${ARMED_LABEL}";`);
});

test("a merge group skips proven queue-only suites but never kept or unproven ones", () => {
  const skippable = heavyProofList.filter(
    (job) => !mergeGroupHeavyKeep.includes(job),
  );
  const allSkipped = Object.fromEntries(
    skippable.map((job) => [job, "skipped"]),
  );
  expectResultGates([
    {
      label: "proven group skips every skippable queue-only suite",
      options: {
        event: EVENT.mergeGroup,
        results: allSkipped,
        plannedOutputs: { heavy_proof: "false", queue_depth: "thin" },
      },
      exitCode: 0,
    },
    {
      label: "proven full-depth queue skips them too",
      options: {
        event: EVENT.mergeGroup,
        results: allSkipped,
        plannedOutputs: { heavy_proof: "false" },
      },
      exitCode: 0,
    },
    ...mergeGroupHeavyKeep
      .filter((job) => heavyProofList.includes(job))
      .map((job) => ({
        label: `kept ${job} stays required in a proven group`,
        options: {
          event: EVENT.mergeGroup,
          results: { ...allSkipped, [job]: "skipped" },
          plannedOutputs: { heavy_proof: "false", queue_depth: "thin" },
        },
        exitCode: 1,
      })),
    ...skippable.flatMap((job) => [
      {
        label: `unproven group requires ${job}`,
        options: {
          event: EVENT.mergeGroup,
          results: { [job]: "skipped" },
          plannedOutputs: { heavy_proof: "true", queue_depth: "thin" },
        },
        exitCode: 1,
      },
      {
        label: `proven group still rejects a failed ${job}`,
        options: {
          event: EVENT.mergeGroup,
          results: { ...allSkipped, [job]: "failure" },
          plannedOutputs: { heavy_proof: "false", queue_depth: "thin" },
        },
        exitCode: 1,
      },
    ]),
  ]);
});

test("an armed pull request run requires every planned queue-only suite", () => {
  const allSkipped = Object.fromEntries(
    heavyProofList.map((job) => [job, "skipped"]),
  );
  expectResultGates([
    {
      label: "an unarmed pull request skips the queue-only suites",
      options: { event: EVENT.pullRequest, results: allSkipped },
      exitCode: 0,
    },
    {
      label: "an armed run with every suite green passes",
      options: {
        event: EVENT.pullRequest,
        results: {},
        plannedOutputs: { heavy_proof: "true" },
      },
      exitCode: 0,
    },
    ...heavyProofList.flatMap((job) => [
      {
        label: `an armed run requires planned ${job}`,
        options: {
          event: EVENT.pullRequest,
          results: { [job]: "skipped" },
          plannedOutputs: { heavy_proof: "true" },
        },
        exitCode: 1,
      },
      {
        label: `an armed run may skip unplanned ${job}`,
        options: {
          event: EVENT.pullRequest,
          results: { [job]: "skipped" },
          unplannedScopes: [jobScopes[job] ?? ""],
          plannedOutputs: { heavy_proof: "true" },
        },
        exitCode: 0,
      },
    ]),
    {
      label: "an armed run checks folded docker suites",
      options: {
        event: EVENT.pullRequest,
        results: {},
        suiteResults: { "agent-sandbox-docker": "failure" },
        plannedOutputs: { heavy_proof: "true" },
      },
      exitCode: 1,
    },
  ]);
});

const normalSkipped = Object.fromEntries(
  resultJob.needs
    .filter(
      (job) =>
        job !== "ci-plan" &&
        job !== activeJobForEvent("ci-quick-checks", EVENT.pullRequest) &&
        !heavyProofList.includes(job),
    )
    .map((job) => [job, "skipped"]),
);

test("an armed delta proves only the queue-only suites on reused normal evidence", () => {
  const delta = {
    heavy_proof: "true",
    armed_delta: "true",
    run_required: "false",
    normal_source_run_id: "99",
  };
  expectResultGates([
    {
      label: "normal suites skipped, queue-only suites green",
      options: {
        event: EVENT.pullRequest,
        results: normalSkipped,
        plannedOutputs: delta,
      },
      exitCode: 0,
    },
    {
      label: "a delta without a reusable source run fails",
      options: {
        event: EVENT.pullRequest,
        results: normalSkipped,
        plannedOutputs: { ...delta, normal_source_run_id: "" },
      },
      exitCode: 1,
    },
    {
      label: "a delta never certifies a merge group",
      options: {
        event: EVENT.mergeGroup,
        results: normalSkipped,
        plannedOutputs: delta,
      },
      exitCode: 1,
    },
    {
      label: "an armed delta still requires the current quick-check carrier",
      options: {
        event: EVENT.pullRequest,
        results: {
          ...normalSkipped,
          [activeJobForEvent("ci-quick-checks", EVENT.pullRequest)]: "skipped",
        },
        plannedOutputs: delta,
      },
      exitCode: 1,
    },
    ...heavyProofList.map((job) => ({
      label: `a delta requires planned ${job}`,
      options: {
        event: EVENT.pullRequest,
        results: { ...normalSkipped, [job]: "skipped" },
        plannedOutputs: delta,
      },
      exitCode: 1,
    })),
    {
      label: "without the delta a skipped normal suite still fails",
      options: {
        event: EVENT.pullRequest,
        results: normalSkipped,
        plannedOutputs: { heavy_proof: "true" },
      },
      exitCode: 1,
    },
  ]);
});

const quickCarrierScenarios = FAST_DEPTH_EVENTS.flatMap((event) =>
  ["normal-v1", "pilot-fast-v1"].flatMap((coverageProfile) =>
    (event === EVENT.pullRequest ? ["normal", "armed-delta"] : ["normal"]).map(
      (mode) => ({ event, coverageProfile, mode }),
    ),
  ),
);

test.each(quickCarrierScenarios)(
  "fast-depth $event $coverageProfile $mode requires the current quick-check carrier",
  ({ event, coverageProfile, mode }) => {
    const pilot = pilotFastJobs({ jobs: ciJobs });
    if (pilot.status === "invalid") {
      panic(pilot.message);
    }
    const active = activeJobForEvent("ci-quick-checks", event);
    const inactive =
      active === "pr-heavy-gate" ? "ci-quick-checks" : "pr-heavy-gate";
    expect(heavyProofList).not.toContain(active);
    const outcomes = [
      { result: "success", evidence: "missing", newer: "none", expected: 0 },
      {
        result: "skipped",
        evidence: "superseded",
        newer: "same-group",
        expected: 1,
      },
      {
        result: "failure",
        evidence: "superseded",
        newer: "same-group",
        expected: 1,
      },
      {
        result: "cancelled",
        evidence: "timeout",
        newer: "same-group",
        expected: 1,
      },
      { result: "cancelled", evidence: "missing", newer: "none", expected: 1 },
      {
        result: "cancelled",
        evidence: "superseded",
        newer: "same-group",
        expected: 0,
      },
    ] as const;
    for (const { item, exitCode, stdout, stderr } of runBashBatch(
      outcomes,
      (outcome) => {
        const base = resultGateCase({
          event,
          suiteDepth: SUITE_DEPTH.fast,
          results: {
            ...(mode === "armed-delta" ? normalSkipped : {}),
            [inactive]: "skipped",
            [active]: outcome.result,
          },
          cancellationEvidence: outcome.evidence,
          newerRun: outcome.newer,
          plannedOutputs: {
            coverage_profile: coverageProfile,
            ...(mode === "armed-delta"
              ? {
                  heavy_proof: "true",
                  armed_delta: "true",
                  run_required: "false",
                  normal_source_run_id: "99",
                }
              : {}),
          },
        });
        return {
          ...base,
          env: {
            ...base.env,
            COVERAGE_PROFILE: coverageProfile,
            PILOT_FAST_JOBS: JSON.stringify(pilot.jobs),
          },
        };
      },
    )) {
      expect(
        exitCode,
        `${active}/${item.result}/${item.evidence}/${item.newer}\n${stdout}\n${stderr}`,
      ).toBe(item.expected);
    }
  },
);

test("an armed delta skips every normal job but still runs the queue-only suites", () => {
  const plan = v.parse(
    v.object({
      outputs: v.record(v.string(), v.string()),
      steps: v.array(v.unknown()),
    }),
    ciJobs["ci-plan"],
  );
  expect(plan.outputs["run_required"]).toBe(
    `\${{ steps.suites.outputs.run_required }}`,
  );
  const suites = v.parse(
    v.object({ run: v.string() }),
    flattenWorkflowSteps(plan.steps).find((step) => step["id"] === "suites"),
  ).run;
  const resolveSuites = (
    normalReused: string,
    runRequired: string,
    routeSmoke = "false",
    suiteDepth = "fast",
  ) => {
    const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-suites-"));
    try {
      const output = nodePath.join(directory, "output");
      const child = Bun.spawnSync(["bash", "-euc", suites], {
        env: {
          PATH: Bun.env["PATH"] ?? "",
          GITHUB_OUTPUT: output,
          NORMAL_REUSED: normalReused,
          EVENT_NAME: "pull_request",
          ARMED: "true",
          NORMAL_SOURCE_RUN_ID: "99",
          RUN_REQUIRED: runRequired,
          ROUTE_SMOKE_REQUIRED: routeSmoke,
          MARKETING_REQUIRED: "false",
          SUITE_DEPTH: suiteDepth,
        },
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      return readFileSync(output, "utf-8").trim();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  expect(resolveSuites("true", "true")).toBe(
    "run_required=false\narmed_delta=true\nheavy_proof=true",
  );
  // Route smoke needs this run's web build, so it keeps the full run.
  expect(resolveSuites("true", "true", "true")).toBe(
    "run_required=true\narmed_delta=false\nheavy_proof=true",
  );
  expect(resolveSuites("", "true")).toBe(
    "run_required=true\narmed_delta=false\nheavy_proof=true",
  );
  expect(resolveSuites("", "false")).toBe(
    "run_required=false\narmed_delta=false\nheavy_proof=false",
  );
  // ci-result accepts an armed delta only at fast depth, so full depth runs all.
  expect(resolveSuites("true", "true", "false", "full")).toBe(
    "run_required=true\narmed_delta=false\nheavy_proof=true",
  );
  expect(plan.outputs["armed_delta"]).toBe(
    `\${{ steps.suites.outputs.armed_delta }}`,
  );
  const gated = heavyProofJobs({ jobs: ciJobs });
  for (const job of resultJob.needs) {
    if (job === "ci-plan" || job === "ci-quick-checks") {
      continue;
    }
    const scheduled = armedRuns(
      jobIf(ciJobs[job]).replaceAll(
        "needs.ci-plan.outputs.run_required",
        "'false'",
      ),
      EVENT.pullRequest,
      "true",
    );
    // The queue-only suites wait on the gate, so it runs with them.
    expect(scheduled, job).toBe(gated.includes(job) || job === "pr-heavy-gate");
  }
});

const TARGET_BASE_SCRIPT = nodePath.join(
  import.meta.dir,
  "merge-target-base.sh",
);

/** Runs the comparison-base resolver in `cwd` and returns its output. */
const resolveTargetBase = (
  cwd: string,
  env: Record<string, string>,
  expectedExit = 0,
) => {
  const output = nodePath.join(cwd, ".resolver-output");
  writeFileSync(output, "");
  const result = Bun.spawnSync(["bash", TARGET_BASE_SCRIPT], {
    cwd,
    // A missing ref is retried like any failed fetch; no waits here.
    env: {
      PATH: Bun.env["PATH"] ?? "",
      GITHUB_OUTPUT: output,
      RETRY_DELAYS_SECONDS: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(expectedExit);
  return readFileSync(output, "utf-8")
    .trim()
    .replace(/^base_sha=/u, "");
};

test("a merge group certifies every queue entry it merges against the target branch", () => {
  const root = realpathSync(
    mkdtempSync(nodePath.join(tmpdir(), "merge-target-base-")),
  );
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
      env: {
        PATH: Bun.env["PATH"] ?? "",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@localhost",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@localhost",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  const commit = (cwd: string, file: string, message: string) => {
    mkdirSync(nodePath.dirname(nodePath.join(cwd, file)), { recursive: true });
    writeFileSync(nodePath.join(cwd, file), `${message}\n`);
    git(cwd, "add", file);
    git(cwd, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  try {
    const origin = nodePath.join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=main");
    const main = commit(origin, "README.md", "main");
    // Queue entry 1 changes a production web spec; entry 2 only docs. The
    // group for entry 2 is built on entry 1's commit.
    git(origin, "checkout", "--quiet", "-b", "queue");
    const entry1 = commit(
      origin,
      "apps/web/e2e/specs/queued.spec.ts",
      "entry 1",
    );
    const entry2 = commit(origin, "docs/queued.md", "entry 2");
    const group = nodePath.join(root, "group");
    git(root, "clone", "--quiet", "--no-checkout", origin, "group");
    git(group, "checkout", "--quiet", "--detach", entry2);

    const base = resolveTargetBase(group, {
      EVENT_NAME: "merge_group",
      TARGET_REF: "refs/heads/main",
    });
    expect(base).toBe(main);
    const changed = (from: string) =>
      git(group, "diff", "--name-only", `${from}...${entry2}`).split("\n");
    expect(changed(base).toSorted()).toEqual([
      "apps/web/e2e/specs/queued.spec.ts",
      "docs/queued.md",
    ]);
    expect(
      runSelector(
        changed(base),
        ["e2e_production_required"],
        "full",
        "false",
        "merge_group",
      ),
    ).toEqual(["true"]);
    // The previous entry's commit (merge_group.base_sha) sees only entry 2,
    // which is why the group must not plan against it.
    expect(changed(entry1)).toEqual(["docs/queued.md"]);
    expect(
      runSelector(
        changed(entry1),
        ["e2e_production_required"],
        "full",
        "false",
        "merge_group",
      ),
    ).toEqual(["false"]);

    // An unresolvable target branch fails the plan rather than handing an
    // empty base to a consumer that would compare HEAD with itself.
    expect(
      resolveTargetBase(
        group,
        { EVENT_NAME: "merge_group", TARGET_REF: "refs/heads/missing" },
        1,
      ),
    ).toBe("");
    // A pull request checkout that is not its merge commit keeps its own base.
    expect(
      resolveTargetBase(group, {
        EVENT_NAME: "pull_request",
        PR_BASE_SHA: main,
        PR_HEAD_SHA: entry2,
      }),
    ).toBe(main);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pull request merge commit compares against the tip it was merged onto, not the event's older base", () => {
  const root = realpathSync(
    mkdtempSync(nodePath.join(tmpdir(), "pr-comparison-base-")),
  );
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
      env: {
        PATH: Bun.env["PATH"] ?? "",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@localhost",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@localhost",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  const commit = (cwd: string, file: string, message: string) => {
    mkdirSync(nodePath.dirname(nodePath.join(cwd, file)), { recursive: true });
    writeFileSync(nodePath.join(cwd, file), `${message}\n`);
    git(cwd, "add", file);
    git(cwd, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const pullRequest = (cwd: string, prBase: string, prHead: string) =>
    resolveTargetBase(cwd, {
      EVENT_NAME: "pull_request",
      PR_BASE_SHA: prBase,
      PR_HEAD_SHA: prHead,
    });
  try {
    const repo = nodePath.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "--quiet", "--initial-branch=main");
    // The event's base: main when the pull request last synchronized.
    const eventBase = commit(repo, "README.md", "main");
    git(repo, "checkout", "--quiet", "-b", "feature");
    const head = commit(repo, "docs/feature.md", "pull request");
    // main moves on with a production web spec before the run checks out
    // GitHub's merge commit, which is built on the newer tip.
    git(repo, "checkout", "--quiet", "main");
    const tip = commit(repo, "apps/web/e2e/specs/main.spec.ts", "main moves");
    git(
      repo,
      "-c",
      "commit.gpgsign=false",
      "merge",
      "--quiet",
      "--no-ff",
      "-m",
      "merge",
      head,
    );
    const changed = (from: string) =>
      git(repo, "diff", "--name-only", `${from}...HEAD`).split("\n");

    const base = pullRequest(repo, eventBase, head);
    expect(base).toBe(tip);
    expect(changed(base)).toEqual(["docs/feature.md"]);
    expect(
      runSelector(
        changed(base),
        ["e2e_production_required"],
        "full",
        "false",
        "pull_request",
      ),
    ).toEqual(["false"]);
    // The event's base would count main's spec as the pull request's change.
    expect(changed(eventBase).toSorted()).toEqual([
      "apps/web/e2e/specs/main.spec.ts",
      "docs/feature.md",
    ]);
    expect(
      runSelector(
        changed(eventBase),
        ["e2e_production_required"],
        "full",
        "false",
        "pull_request",
      ),
    ).toEqual(["true"]);

    // A merge whose second parent is not the pull request head keeps the
    // event's base.
    expect(pullRequest(repo, eventBase, eventBase)).toBe(eventBase);
    // A shallow checkout lists no parents and keeps the event's base too.
    git(root, "clone", "--quiet", "--depth=1", `file://${repo}`, "shallow");
    expect(pullRequest(nodePath.join(root, "shallow"), eventBase, head)).toBe(
      eventBase,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the resolver chooses a run's comparison base", () => {
  const offenders: string[] = [];
  const pullRequestOffenders: string[] = [];
  for (const pattern of [
    ".github/workflows/*.yml",
    ".github/actions/*/action.yml",
    // Pooled checks evaluate their own expressions, so they read the base too.
    ".github/ci-checks/*.yml",
  ]) {
    for (const file of new Bun.Glob(pattern).scanSync({
      cwd: nodePath.join(import.meta.dir, ".."),
    })) {
      const source = readFileSync(
        nodePath.join(import.meta.dir, "..", file),
        "utf-8",
      );
      for (const [index, line] of source.split("\n").entries()) {
        // A pull request run of ci.yml checks out GitHub's merge commit,
        // which the event's base can lag. Only the resolver (and the patch
        // id, which diffs the pull request head itself) reads that base.
        if (
          (file === ".github/workflows/ci.yml" ||
            !file.startsWith(".github/workflows/")) &&
          /pull_request\??\.base\.sha/u.test(line) &&
          !line.trim().startsWith("PR_BASE_SHA:") &&
          !(
            file === ".github/workflows/ci.yml" &&
            line.trim().startsWith("BASE_SHA:") &&
            line.includes("|| needs.ci-plan.outputs.target_base_sha")
          )
        ) {
          pullRequestOffenders.push(`${file}:${String(index + 1)}`);
        }
        if (!/merge_group\??\.base_sha/u.test(line)) {
          continue;
        }
        // The patch id names an entry's own change, so it alone diffs
        // against the previous queue entry.
        if (
          file === ".github/workflows/ci.yml" &&
          line.trim().startsWith("GROUP_BASE_SHA:")
        ) {
          continue;
        }
        offenders.push(`${file}:${String(index + 1)}`);
      }
    }
  }
  expect(offenders).toEqual([]);
  expect(pullRequestOffenders).toEqual([]);
  const patchId = jobSteps(ciJobs["ci-plan"]).find(
    ({ name }) => name === "Compute stable patch id",
  );
  expect(JSON.stringify(patchId)).toContain(
    "github.event.merge_group.base_sha",
  );
  const certified = jobSteps(ciJobs["ci-result"]).find(
    ({ name }) => name === "Record the certified comparison base",
  );
  expect(JSON.stringify(certified)).toContain(
    "needs.ci-plan.outputs.target_base_sha",
  );
  expect(certified?.run).toContain("GITHUB_STEP_SUMMARY");
  // ci-plan runs the workflow revision's own resolver, never the copy in the
  // tree it certifies.
  const resolver = jobSteps(ciJobs["ci-plan"]).find(
    ({ name }) => name === "Resolve comparison base",
  );
  expect(resolver?.run).toBe('bash "$RUNNER_TEMP/merge-target-base.sh"');
  expect(JSON.stringify(jobSteps(ciJobs["ci-plan"]))).toContain(
    "scripts/merge-target-base.sh",
  );
});

// The jobs that wait on pr-heavy-gate directly; the rest wait through them.
const GATED_HEAVY_ROOTS = [
  "ci-browser",
  "ci-tests",
  "e2e-landing",
  "postgres-service-suites",
  "service-suites",
  "web-build",
] as const;

test("the planner derives the PR heavy jobs from everything waiting on the gate", () => {
  expect(PR_HEAVY_JOBS).toEqual([
    "api-test-durations",
    "ci-browser",
    "ci-tests",
    "e2e-landing",
    "e2e-production-shard",
    "e2e-report",
    "marketing-screenshots",
    "marketing-screenshots-cancel",
    "postgres-service-suites",
    "route-smoke",
    "service-suites",
    "web-build",
  ]);
  for (const job of GATED_HEAVY_ROOTS) {
    expect(
      v.parse(v.object({ needs: v.array(v.string()) }), ciJobs[job]).needs,
      job,
    ).toEqual(["ci-plan", "pr-heavy-gate"]);
  }
  expect(fastRequired.filter((job) => PR_HEAVY_JOBS.includes(job))).toEqual(
    expect.arrayContaining(["ci-tests", "ci-browser", "web-build"]),
  );
});

type HeavyRunOptions = { event: Event; gate: string };
// Resolve the heavy jobs in dependency order, each job seeing the results of
// the heavy jobs it needs, with every plan scope planned.
const heavyJobsThatRun = ({ event, gate }: HeavyRunOptions) => {
  const results = new Map<string, string>([["pr-heavy-gate", gate]]);
  const pending = [...PR_HEAVY_JOBS];
  while (pending.length > 0) {
    const index = pending.findIndex((job) =>
      v
        .parse(
          v.object({ needs: v.union([v.string(), v.array(v.string())]) }),
          ciJobs[job],
        )
        .needs.toString()
        .split(",")
        .every((need) => !PR_HEAVY_JOBS.includes(need) || results.has(need)),
    );
    const [job] = pending.splice(index, 1);
    if (index === -1 || job === undefined) {
      panic("PR heavy jobs form a dependency cycle");
    }
    const runs = evaluate(jobIf(ciJobs[job]), {
      values: {
        "github.event_name": event,
        "inputs.heavy_only": false,
        "inputs.pr_depth_only": false,
        "needs.ci-plan.result": "success",
        "needs.ci-plan.outputs.coverage_profile": "normal-v1",
        "needs.ci-plan.outputs.pilot_fast_jobs": "[]",
        "needs.ci-plan.outputs.suite_depth":
          event === EVENT.pullRequest ? SUITE_DEPTH.fast : SUITE_DEPTH.full,
        "needs.ci-plan.outputs.queue_depth": "full",
        "needs.ci-plan.outputs.heavy_web_build_required": "false",
        "vars.CI_POSTGRES_PR_SELECTION": "on",
        "vars.QUEUE_BROWSER_SUITES": "",
        "github.ref": "refs/heads/main",
        // Only a heavy-only dispatch builds through heavy-web-build.
        "needs.heavy-web-build.result": "skipped",
        ...Object.fromEntries(
          [...results].map(([need, result]) => [
            `needs.${need}.result`,
            result,
          ]),
        ),
      },
      status: { always: true, success: true, failure: false, cancelled: false },
      fallback: (path) => {
        if (path.startsWith("needs.ci-plan.outputs.")) {
          return "true";
        }
        return /^needs\.[\w-]+\.result$/u.test(path) ? "success" : undefined;
      },
    });
    if (typeof runs !== "boolean") {
      panic(`Unresolved heavy job predicate: ${job}`);
    }
    results.set(job, runs ? "success" : "skipped");
  }
  return PR_HEAVY_JOBS.filter((job) => results.get(job) === "success");
};

test("a pull request starts no heavy suite unless its gate passed; a merge group never waits on it", () => {
  expect(
    heavyJobsThatRun({ event: EVENT.pullRequest, gate: "success" }),
  ).toEqual(
    expect.arrayContaining([...GATED_HEAVY_ROOTS, "e2e-production-shard"]),
  );
  for (const gate of ["skipped", "failure", "cancelled"]) {
    expect(heavyJobsThatRun({ event: EVENT.pullRequest, gate }), gate).toEqual(
      [],
    );
  }
  for (const event of [EVENT.mergeGroup, EVENT.workflowDispatch]) {
    expect(heavyJobsThatRun({ event, gate: "skipped" }), event).toEqual(
      expect.arrayContaining([...GATED_HEAVY_ROOTS]),
    );
  }
  expect(jobIf(ciJobs["pr-heavy-gate"])).toContain(
    "github.event_name == 'pull_request'",
  );
  expect(
    v.parse(v.object({ needs: v.string() }), ciJobs["pr-heavy-gate"]).needs,
  ).toBe("ci-plan");
});

// The changed-file and planner verdicts the PR heavy jobs are selected by.
const HEAVY_SCOPE_AXES = [
  "steps.changed-files.outputs.package_checks_required",
  "steps.changed-files.outputs.collab_redis_required",
  "steps.changed-files.outputs.ci_browser_scope_required",
  "steps.changed-files.outputs.desktop_browser_required",
  "steps.changed-files.outputs.postgres_suites_required",
  "steps.changed-files.outputs.service_suites_pr_required",
  "steps.changed-files.outputs.corpus_suites_required",
  "steps.e2e-pr-plan.outputs.selection_required",
  "steps.e2e-pr-plan.outputs.required",
] as const;

test("every scope that plans a pull request heavy suite also plans its gate", () => {
  const { outputs } = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  let combinations: Record<string, string>[] = [{}];
  for (const axis of HEAVY_SCOPE_AXES) {
    combinations = combinations.flatMap((scopes) =>
      ["true", "false"].map((value) => ({ ...scopes, [axis]: value })),
    );
  }
  let planned = 0;
  for (const scopes of combinations) {
    const context = contextWithPlanOutputs({
      outputs,
      context: {
        values: {
          ...scopes,
          "github.event_name": EVENT.pullRequest,
          "inputs.heavy_only": false,
          "inputs.pr_depth_only": false,
          "vars.CI_POSTGRES_PR_SELECTION": "on",
          "steps.check.outputs.trusted": "true",
          "steps.completed-depth.outputs.run_required": "true",
          "steps.completed-depth.outputs.pr_heavy_suites": "run",
          "steps.suites.outputs.run_required": "true",
          "steps.suites.outputs.armed_delta": "false",
          "steps.depth.outputs.suite_depth": SUITE_DEPTH.fast,
          "steps.pilot.outputs.coverage_profile": "normal-v1",
          "needs.ci-plan.result": "success",
          "needs.pr-heavy-gate.result": "success",
        },
        status: { cancelled: false },
        // GitHub reads an output its producing step never set as empty.
        fallback: (path) => (path.startsWith("steps.") ? "" : undefined),
      },
    });
    context.values["needs.ci-plan.outputs.heavy_proof"] = "true";
    context.values["needs.ci-plan.outputs.run_required"] = "true";
    context.values["needs.ci-plan.outputs.armed_delta"] = "false";
    const gate = context.fallback?.(
      "needs.ci-plan.outputs.pr_heavy_gate_required",
    );
    for (const job of GATED_HEAVY_ROOTS) {
      const runs = evaluateExpression(jobIf(ciJobs[job]), context);
      expect(runs === UNKNOWN, `${job} ${JSON.stringify(scopes)}`).toBe(false);
      if (runs === true) {
        planned++;
        expect(gate, `${job} ${JSON.stringify(scopes)}`).toBe("true");
      }
    }
  }
  expect(planned).toBeGreaterThan(0);
});

test("both quick-check jobs use the identical shared step list", () => {
  const gate = v.parse(
    v.object({ steps: v.array(v.unknown()), "timeout-minutes": v.number() }),
    ciJobs["pr-heavy-gate"],
  );
  const standalone = v.parse(
    v.object({ steps: v.array(v.unknown()), "timeout-minutes": v.number() }),
    ciJobs["ci-quick-checks"],
  );
  expect(gate.steps).toEqual(standalone.steps);
  expect(gate["timeout-minutes"]).toBe(15);
  expect(standalone["timeout-minutes"]).toBe(15);
});

test("a failed PR quick check fails ci-result and skips a heavy suite", () => {
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "pr-heavy-gate": "failure", "ci-tests": "skipped" },
    }),
  ).toBe(1);
  expect(
    heavyJobsThatRun({ event: EVENT.pullRequest, gate: "failure" }),
  ).not.toContain("ci-tests");
});

test("merge-group heavy suites do not depend on the standalone quick-check job", () => {
  for (const job of GATED_HEAVY_ROOTS) {
    const needs = v.parse(
      v.object({ needs: v.array(v.string()) }),
      ciJobs[job],
    ).needs;
    expect(needs).not.toContain("ci-quick-checks");
  }
  expect(
    heavyJobsThatRun({ event: EVENT.mergeGroup, gate: "skipped" }),
  ).toEqual(expect.arrayContaining([...GATED_HEAVY_ROOTS]));
});

test("a merge-from-base head skips its heavy suites only on verified reuse, and says why", () => {
  const skipped: Record<string, string> = Object.fromEntries(
    PR_HEAVY_JOBS.filter((job) => resultJob.needs.includes(job)).map((job) => [
      job,
      "skipped",
    ]),
  );
  skipped["pr-heavy-gate"] = "success";
  const parent = "a".repeat(40);
  const reused = {
    pr_heavy_suites: "reused",
    pr_heavy_source_run_id: "99",
    pr_heavy_source_sha: parent,
  };
  // Reuse skips the heavy suites, but quick checks still run in the gate.
  const pullRequest = { event: EVENT.pullRequest } as const;
  const outcome = onlyOutcome(
    evaluateResults(
      [{ ...pullRequest, results: skipped, plannedOutputs: reused }],
      (item) => item,
    ),
  );
  expect(outcome.exitCode, outcome.stderr).toBe(0);
  expect(outcome.stdout).toContain(
    `Heavy suites skipped: this head only merges the base into ${parent}, whose run 99 passed with the same patch id`,
  );
  expectResultGates([
    {
      label: "heavy skips without the planner's reuse verdict",
      options: { ...pullRequest, results: skipped },
      exitCode: 1,
    },
    ...[
      { ...reused, pr_heavy_source_run_id: "" },
      { ...reused, pr_heavy_source_run_id: "0" },
      { ...reused, pr_heavy_source_sha: "main" },
    ].map((plannedOutputs) => ({
      label: `malformed reuse ${JSON.stringify(plannedOutputs)}`,
      options: { ...pullRequest, results: skipped, plannedOutputs },
      exitCode: 1,
    })),
    ...["pr-heavy-gate", "ci-checks-rest", "code-quality-api"].map((job) => ({
      label: `reuse keeps ${job} required`,
      options: {
        ...pullRequest,
        results: { ...skipped, [job]: "skipped" },
        plannedOutputs: reused,
      },
      exitCode: 1,
    })),
    {
      label: "reuse keeps failures red",
      options: {
        ...pullRequest,
        results: { ...skipped, "pr-heavy-gate": "failure" },
        plannedOutputs: reused,
      },
      exitCode: 1,
    },
  ]);
});
