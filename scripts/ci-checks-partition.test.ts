import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { createContext, runInContext } from "node:vm";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";

import { testProcessBudgets } from "../apps/api/scripts/test-process-supervisor";
import { CANONICAL_CANCEL_STEP } from "./ci-cancellation-contract";
import {
  CHECK_POOL_JOBS,
  CHECK_POOL_STEP_NAMES,
  type CheckPoolJob,
  checkPoolRegistryPath,
  checkPoolStepRun,
  type ReadCheckPool,
  readCheckPool,
  readWorkingTreeCheckPool,
} from "./ci-check-pool-registry";
import { CI_GATES, CONTINUE_ON_ERROR } from "./ci-gate-classes";
import { rootCheckGate } from "./ci-root-check-gate";
import { STATIC_RECEIPT_STEP_NAMES } from "./ci-static-checks";
import { withoutStaticReuseCondition } from "./ci-static-checks.test-support";
import { CI_GENERATED_OUTPUTS } from "./generated-files";
import {
  DELEGATED_CHECKS_ENV,
  UNCHANGED_CHECKS_ENV,
} from "./generated-files-guard";
import { customLintTestCommand } from "./run-custom-lint-tests";
import { jobCachePolicy } from "./workflow-cache-policy.ts";
import { flattenWorkflowSteps, isWorkflowBarrier } from "./workflow-steps";

// Receipt wiring is checked against the real graph in ci-static-checks.test.ts;
// this census still compares each underlying command and original condition.
const withoutStaticReceipts = (steps: Record<string, unknown>[]) => {
  const normalized = steps
    .filter(
      (step) =>
        !STATIC_RECEIPT_STEP_NAMES.some((name) => name === step["name"]),
    )
    .map((step) => {
      const result = { ...withoutStaticReuseCondition(step) };
      const rawEnv = step["env"];
      if (
        typeof rawEnv === "object" &&
        rawEnv !== null &&
        !Array.isArray(rawEnv)
      ) {
        const env = Object.fromEntries(
          Object.entries(rawEnv).filter(
            ([key]) =>
              ![
                "CI_CHECK_KIND",
                "CI_CHECK_INPUTS",
                "CI_CHECK_CONTEXT",
                // Matrix metadata selects a disjoint slice of the same pool;
                // it does not change the check represented by this step.
                "CI_CHECK_POOL_PARTITION",
              ].includes(key),
          ),
        );
        if (Object.keys(env).length === 0) {
          delete result["env"];
        } else {
          result["env"] = env;
        }
      }
      if (typeof result["if"] === "string") {
        result["if"] = result["if"].replace(
          "(steps.standalone_lockfiles.outcome == 'success' || steps.static_receipts.outputs.reuse_standalone_lockfiles == 'true')",
          "steps.standalone_lockfiles.outcome == 'success'",
        );
      }
      if (
        typeof result["id"] === "string" &&
        result["id"].startsWith("static_check_")
      ) {
        delete result["id"];
      }
      return result;
    });
  // Bun must precede the receipt resolver and the install-free shell guards.
  const localGuard = normalized.findIndex(
    (step) => step["name"] === "Check local skill overrides",
  );
  const setup = normalized.findIndex((step) => step["name"] === "Setup Bun");
  if (localGuard !== -1 && setup !== -1 && setup < localGuard) {
    const [bun] = normalized.splice(setup, 1);
    if (bun) {
      normalized.splice(localGuard, 0, bun);
    }
  }
  return normalized;
};

// Pooled checks are steps of their job, read from the audited tree's registry.
const cancellationJobSchema = (
  canonical: object,
  readPool: ReadCheckPool = readWorkingTreeCheckPool,
) =>
  v.pipe(
    v.looseObject({
      permissions: v.optional(v.record(v.string(), v.string())),
      steps: v.pipe(
        v.unknown(),
        v.transform((steps) =>
          flattenWorkflowSteps(steps, readPool).filter(
            (step) => !isWorkflowBarrier(step),
          ),
        ),
        v.array(v.looseObject({ name: v.string() })),
      ),
    }),
    v.transform((job) => {
      if (
        !isDeepStrictEqual(job.steps.at(-1), {
          ...canonical,
          if: "failure() && github.event_name == 'merge_group'",
        })
      ) {
        return job;
      }
      expect(job.permissions?.["actions"]).toBe("write");
      const permissions = { ...job.permissions };
      delete permissions["actions"];
      return { ...job, permissions, steps: job.steps.slice(0, -1) };
    }),
  );
const headCancellationSchema = cancellationJobSchema(CANONICAL_CANCEL_STEP);
const partitionJobSchema = (
  cancellation: ReturnType<typeof cancellationJobSchema>,
) =>
  v.pipe(
    cancellation,
    v.transform((job) => {
      const result = { ...job };
      result.steps = v.parse(
        v.array(v.looseObject({ name: v.string() })),
        withoutStaticReceipts(job.steps),
      );
      if (
        "env" in job &&
        typeof job["env"] === "object" &&
        job["env"] !== null
      ) {
        result["env"] = Object.fromEntries(
          Object.entries(job["env"]).filter(
            ([key]) =>
              !["CI_CANCELLATION_KIND", "CI_CANCELLATION_CONTEXT"].includes(
                key,
              ),
          ),
        );
      }
      return result;
    }),
  );
const headJobSchema = partitionJobSchema(headCancellationSchema);
const workflowSchema = v.object({ jobs: v.record(v.string(), v.unknown()) });
const removalSchema = v.array(
  v.object({ name: v.string(), reason: v.pipe(v.string(), v.minLength(1)) }),
);
const workflowPath = ".github/workflows/ci.yml";
const removalsPath = "scripts/ci-checks-removed.json";
const repository = new URL("../", import.meta.url).pathname;
const processBudgetEnvSchema = v.optional(v.record(v.string(), v.unknown()));
const processBudgetWorkflowSchema = v.looseObject({
  env: processBudgetEnvSchema,
  jobs: v.record(
    v.string(),
    v.looseObject({
      env: processBudgetEnvSchema,
      "timeout-minutes": v.optional(v.unknown()),
      steps: v.optional(
        v.pipe(
          v.unknown(),
          v.transform((steps) => flattenWorkflowSteps(steps)),
          v.array(v.looseObject({ env: processBudgetEnvSchema })),
        ),
      ),
    }),
  ),
});
const declaredProcessBudgetsSchema = v.object({
  API_TEST_CHILD_TIMEOUT_MS: v.optional(v.string()),
  API_TEST_RUNNER_DEADLINE_MS: v.optional(v.string()),
});

const assertJobProcessBudgets = (
  workflow: v.InferOutput<typeof processBudgetWorkflowSchema>,
  requireNightlyBudget: boolean,
) => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? [{}]) {
      const declared = v.parse(declaredProcessBudgetsSchema, {
        ...workflow.env,
        ...job.env,
        ...step.env,
      });
      if (requireNightlyBudget) {
        expect(
          declared.API_TEST_CHILD_TIMEOUT_MS,
          `${name} needs an explicit nightly child budget`,
        ).toBeDefined();
        expect(
          declared.API_TEST_RUNNER_DEADLINE_MS,
          `${name} needs an explicit nightly runner deadline`,
        ).toBeDefined();
      }
      if (
        declared.API_TEST_CHILD_TIMEOUT_MS === undefined &&
        declared.API_TEST_RUNNER_DEADLINE_MS === undefined
      ) {
        continue;
      }
      const timeout = v.parse(v.number(), job["timeout-minutes"]) * 60_000;
      const limits = testProcessBudgets(declared);
      expect(
        limits.childTimeoutMs,
        `${name} child budget must fit inside its job`,
      ).toBeLessThan(timeout);
      expect(
        limits.deadlineMs,
        `${name} runner deadline must leave job cleanup time`,
      ).toBeLessThan(timeout);
      if (requireNightlyBudget) {
        expect(limits.childTimeoutMs).toBeGreaterThan(
          testProcessBudgets({}).childTimeoutMs,
        );
      }
    }
  }
};

test("explicit API process budgets leave cleanup time in every consuming workflow job", () => {
  for (const file of new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
    cwd: repository,
  })) {
    const workflow = v.parse(
      processBudgetWorkflowSchema,
      Bun.YAML.parse(
        readFileSync(new URL(`../${file}`, import.meta.url), "utf-8"),
      ),
    );
    assertJobProcessBudgets(
      workflow,
      file === ".github/workflows/nightly-property-test.yml",
    );
  }
});

test("process budget guard rejects missing, inherited and step-level timeout violations", () => {
  const workflow = v.parse(processBudgetWorkflowSchema, {
    env: {
      API_TEST_CHILD_TIMEOUT_MS: "1200000",
      API_TEST_RUNNER_DEADLINE_MS: "2100000",
    },
    jobs: { property: { "timeout-minutes": 45, steps: [{ env: {} }] } },
  });
  assertJobProcessBudgets(workflow, true);
  const missing = structuredClone(workflow);
  delete missing.env?.["API_TEST_CHILD_TIMEOUT_MS"];
  expect(() => assertJobProcessBudgets(missing, true)).toThrow(
    "explicit nightly child budget",
  );
  const shortJob = structuredClone(workflow);
  for (const job of Object.values(shortJob.jobs)) {
    job["timeout-minutes"] = 20;
  }
  expect(() => assertJobProcessBudgets(shortJob, true)).toThrow(
    "child budget must fit inside its job",
  );
  for (const deadline of ["2700000", "2700001"]) {
    const mutation = structuredClone(workflow);
    mutation.env = {
      ...workflow.env,
      API_TEST_RUNNER_DEADLINE_MS: deadline,
    };
    expect(() => assertJobProcessBudgets(mutation, true)).toThrow(
      "runner deadline must leave job cleanup time",
    );
  }
  for (const level of ["workflow", "job", "step"] as const) {
    const mutation = structuredClone(workflow);
    const environment = {
      API_TEST_CHILD_TIMEOUT_MS: "2700000",
      API_TEST_RUNNER_DEADLINE_MS: "3000000",
    };
    if (level === "workflow") {
      mutation.env = environment;
    }
    for (const job of Object.values(mutation.jobs)) {
      if (level === "job") {
        job.env = environment;
      }
      if (level === "step") {
        job.steps = [{ env: environment }];
      }
    }
    expect(() => assertJobProcessBudgets(mutation, true)).toThrow(
      "child budget must fit inside its job",
    );
  }
});

const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: repository });
  if (result.exitCode !== 0) {
    panic(`CI check baseline unavailable: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};
const trackedFiles = new Set(
  git(["ls-files", "-z"]).split("\0").filter(Boolean),
);

const normalizeGuardPathLines = (run: string, tracked: ReadonlySet<string>) =>
  run.replace(
    /^([ \t]*git diff --exit-code --)[ \t]*\\\n((?:[^\n]*\\\n)*[^\n]*)/gmu,
    (command, prefix: string, argumentsBlock: string) => {
      const lines = argumentsBlock.split("\n");
      const kept = lines.filter((line) => {
        const argument = line.trim().replace(/ ?\\$/u, "");
        const match =
          /^(?:"([^"$\x60]+)"|'([^']+)'|([^\s"'$\x60;&|<>\\()]+))$/u.exec(
            argument,
          );
        const path = match?.at(1) ?? match?.at(2) ?? match?.at(3);
        // Commands and nonliteral shell expressions must survive comparison.
        if (path === undefined) {
          return true;
        }
        if (tracked.has(path)) {
          return true;
        }
        const glob = new Bun.Glob(path);
        for (const file of tracked) {
          if (file.startsWith(`${path}/`) || glob.match(file)) {
            return true;
          }
        }
        return false;
      });
      if (kept.length === lines.length) {
        return command;
      }
      if (kept.length === 0) {
        // An empty explicit path list must not match an unscoped diff guard.
        return `${prefix} \\\n`;
      }
      return `${prefix} \\\n${kept.map((line) => line.replace(/[ \t]*\\$/u, "")).join(" \\\n")}`;
    },
  );
// A migration test must also hold once its migration is on the base:
// CI_CHECKS_PARTITION_BASE=HEAD compares the head with itself.
const mergeBase =
  process.env["CI_CHECKS_PARTITION_BASE"] ??
  git(["merge-base", "origin/main", "HEAD"]);
const baseCancellationSource = new Bun.Transpiler({
  loader: "ts",
}).transformSync(
  git(["show", `${mergeBase}:scripts/ci-cancellation-contract.ts`]),
);
const baseCancellation = v.parse(
  v.object({ CANONICAL_CANCEL_STEP: v.record(v.string(), v.unknown()) }),
  await import(
    `data:text/javascript;base64,${Buffer.from(baseCancellationSource).toBase64()}`
  ),
).CANONICAL_CANCEL_STEP;
const readBaseCheckPool: ReadCheckPool = (pool) =>
  git(["show", `${mergeBase}:${checkPoolRegistryPath(pool)}`]);
const baseCancellationSchema = cancellationJobSchema(
  baseCancellation,
  readBaseCheckPool,
);
const baseJobSchema = partitionJobSchema(baseCancellationSchema);
const jobs = v.parse(
  workflowSchema,
  Bun.YAML.parse(
    readFileSync(new URL(`../${workflowPath}`, import.meta.url), "utf-8"),
  ),
).jobs;
// Pool steps once ran `bun scripts/ci-check-pool.ts run <job>` with `needs`
// in the environment; a merge base from before the file hand-over reads in
// today's form, so its pooled checks still expand and compare. Matches only
// the old form, so it is inert once the merge base carries the new one.
const LEGACY_POOL_RUN = /^bun scripts\/ci-check-pool\.ts run ([\w-]+)$/u;
// Pool steps then ran the pool without `exec`; that form reads as today's too.
const preExecPoolRun = (job: CheckPoolJob) =>
  checkPoolStepRun(job).replace(" exec bun ", " bun ");
const withCurrentPoolSteps = (workflow: unknown): unknown => {
  const parsed = v.parse(
    v.looseObject({ jobs: v.record(v.string(), v.unknown()) }),
    workflow,
  );
  for (const job of CHECK_POOL_JOBS) {
    const body = parsed.jobs[job];
    if (!v.is(v.looseObject({ steps: v.array(v.unknown()) }), body)) {
      continue;
    }
    body.steps = body.steps.map((step) => {
      if (
        !v.is(
          v.looseObject({
            run: v.string(),
            env: v.record(v.string(), v.unknown()),
          }),
          step,
        ) ||
        (LEGACY_POOL_RUN.exec(step.run.trim())?.at(1) !== job &&
          step.run !== preExecPoolRun(job))
      ) {
        return step;
      }
      const { CI_CHECK_POOL_NEEDS: _needs, ...env } = step.env;
      return { ...step, env, run: checkPoolStepRun(job) };
    });
  }
  return parsed;
};
const baseWorkflow: unknown = withCurrentPoolSteps(
  Bun.YAML.parse(git(["show", `${mergeBase}:${workflowPath}`])),
);
const baseJobs = v.parse(workflowSchema, baseWorkflow).jobs;
const removedChecks = v.parse(
  removalSchema,
  JSON.parse(
    readFileSync(new URL(`../${removalsPath}`, import.meta.url), "utf-8"),
  ),
);
// Only declarations introduced by this PR authorize removals. Historical
// declarations cannot authorize dropping a reintroduced check in a later PR.
const baseRemovals = git(["ls-tree", "--name-only", mergeBase, removalsPath])
  ? v.parse(
      removalSchema,
      JSON.parse(git(["show", `${mergeBase}:${removalsPath}`])),
    )
  : [];
const baseRemovalNames = new Set(baseRemovals.map(({ name }) => name));
const newRemovals = removedChecks.filter(
  ({ name }) => !baseRemovalNames.has(name),
);

const partitionIds = [
  "ci-checks-generated",
  "ci-checks-policy",
  "ci-checks-rest",
] as const;
const setupPrerequisites = new Set([
  "Checkout",
  "Setup Bun",
  "Turbo remote cache",
  "Install dependencies",
  "Prepare environment",
]);
// Generation and hydration are preparation; their complete consumer and
// provenance contract is owned by ci-generated-sources.test.ts.
const preparationSteps = new Set([
  "Generate web sources",
  "Generate web route tree",
  "Generate web compiler sources",
  "Download generated sources",
  "Restore generated sources",
]);
const prerequisites = new Set([...setupPrerequisites, ...preparationSteps]);
const partitions = partitionIds.map((id) => v.parse(headJobSchema, jobs[id]));
const readBaseline = (
  source: v.InferOutput<typeof workflowSchema>["jobs"],
  schema = headJobSchema,
) => {
  if (source["ci-checks"] !== undefined) {
    for (const id of partitionIds) {
      expect(source).not.toHaveProperty(id);
    }
    return [v.parse(schema, source["ci-checks"])];
  }
  return partitionIds.map((id) => v.parse(schema, source[id]));
};
const baseline = readBaseline(baseJobs, baseJobSchema);

type Step = v.InferOutput<typeof headJobSchema>["steps"][number];
// A full commit SHA pin is version metadata that dependency updates bump; the
// action path, the fact that it is pinned, and everything else about the step
// must stay intact. A branch or tag ref is left as written, so moving a step
// from a pin to a mutable ref still reads as a modified check.
const PINNED_REF = /@[0-9a-f]{40}$/u;
const usesOf = (step: Step): string | undefined =>
  v.parse(v.looseObject({ uses: v.optional(v.string()) }), step).uses;
const withoutActionRef = (step: Step): Step => {
  const uses = usesOf(step);
  return uses === undefined
    ? step
    : { ...step, uses: uses.replace(PINNED_REF, "@<pinned>") };
};
const CONTINUATION_PREFIXES = {
  checkout: `\${{ !cancelled() && steps.checkout.outcome == 'success'`,
  install: `\${{ !cancelled() && steps.checkout.outcome == 'success' && steps.install.outcome != 'failure' && steps.standalone_lockfiles.outcome != 'failure' && steps.lockfile_ages.outcome != 'failure'`,
  installPackages: `\${{ !cancelled() && steps.install.outcome == 'success'`,
} as const;
const outcomeDependencies: Record<string, string> = {
  "Changeset present for published package changes": "policy",
};
const preInstallGuards = new Map([
  [
    "Standalone lockfile guard",
    "Reject alternate lockfiles before installing dependencies",
  ],
  [
    "Lockfile release-age guard",
    "Reject quarantined versions before installing dependencies",
  ],
]);
const SAFETY_SUFFIX =
  " && steps.standalone_lockfiles.outcome == 'success' && (!(github.event_name != 'workflow_dispatch' && needs.ci-plan.outputs.lockfile_ages_required == 'true') || steps.lockfile_ages.outcome == 'success')";
const stepIds: Record<string, string> = {
  Checkout: "checkout",
  "Install dependencies": "install",
  "Standalone lockfile guard": "standalone_lockfiles",
  "Lockfile release-age guard": "lockfile_ages",
};
const withoutStepId = (step: Step): Step => {
  if (stepIds[step.name] === undefined || step["id"] !== stepIds[step.name]) {
    return step;
  }
  const original = { ...step };
  delete original["id"];
  return original;
};
// Budget and time-based guards carry the continue-on-error their gate class
// in scripts/ci-gate-classes.ts implies; that table and its census own it.
const gateLenience = (name: string) => {
  for (const job of [
    "ci-checks-generated",
    "ci-checks-policy",
    "ci-checks-rest",
  ]) {
    const gate = CI_GATES[job]?.steps?.[name];
    if (gate !== undefined && gate.enforcedBy === undefined) {
      return CONTINUE_ON_ERROR[gate.class];
    }
  }
  return undefined;
};

const withoutGateLenience = (step: Step): Step => {
  const lenience = gateLenience(step.name);
  if (lenience === undefined || step["continue-on-error"] !== lenience) {
    return step;
  }
  const original = { ...step };
  delete original["continue-on-error"];
  return original;
};

const withoutContinuation = (gated: Step): Step => {
  const step = withoutGateLenience(gated);
  const condition = v.parse(
    v.looseObject({ if: v.optional(v.string()) }),
    step,
  ).if;
  if (condition === undefined) {
    return step;
  }
  const dependency = outcomeDependencies[step.name];
  const suffixes =
    dependency === undefined
      ? [" }}"]
      : [` && steps.${dependency}.outcome == 'success' }}`];
  if (step.name === "Install dependencies") {
    suffixes.unshift(`${SAFETY_SUFFIX} }}`);
  }
  for (const continuation of Object.values(CONTINUATION_PREFIXES)) {
    for (const suffix of suffixes) {
      if (condition === `${continuation}${suffix}`) {
        const original = { ...step };
        delete original["if"];
        return original;
      }
      const prefix = `${continuation} && (`;
      const ending = `)${suffix}`;
      if (condition.startsWith(prefix) && condition.endsWith(ending)) {
        return { ...step, if: condition.slice(prefix.length, -ending.length) };
      }
    }
  }
  return step;
};
const setupSteps = (steps: readonly Step[]) =>
  steps
    .filter(({ name }) => setupPrerequisites.has(name))
    .map(withoutContinuation)
    .map(withoutStepId)
    .map(withoutActionRef);
// Task receipts share the GitHub cache server with Turbo; the versioned
// namespace separates their format and relative paths make receipts portable.
const withTaskResultCacheSetup = (step: Step): Step => {
  if (usesOf(step) !== "rharkor/caching-for-turbo@<pinned>") {
    return step;
  }
  const inputs = v.parse(
    v.looseObject({ with: v.optional(v.record(v.string(), v.unknown())) }),
    step,
  ).with;
  return {
    ...step,
    with: {
      ...inputs,
      "server-port": "0",
      provider: "github",
      "cache-prefix": "task-results-v1_",
      "use-relative-cache-path": "true",
    },
  };
};
// PR-depth runs check out the dispatched commit in every leg; a merge base
// whose legs predate that checked out the workflow ref, which is the same
// commit on pull requests and merge groups.
const PR_DEPTH_CHECKOUT_REF = [
  "$",
  "{{ (inputs.heavy_only == true || inputs.pr_depth_only == true) && inputs.sha || '' }}",
].join("");
const withPrDepthCheckoutRef = (step: Step): Step => {
  if (usesOf(step) !== "actions/checkout@<pinned>") {
    return step;
  }
  const inputs = v.parse(
    v.looseObject({ with: v.optional(v.record(v.string(), v.unknown())) }),
    step,
  ).with;
  if (inputs?.["ref"] !== undefined) {
    return step;
  }
  return { ...step, with: { ...inputs, ref: PR_DEPTH_CHECKOUT_REF } };
};
const ownedInstallFlags = '["--frozen-lockfile","--ignore-scripts"]';
const scopedInstallActions = new Set([
  "./.github/actions/ci-install",
  "$/.github/actions/ci-install",
]);
const derivedInstallTimeout = (job: Record<string, unknown>) => {
  const runners = Array.isArray(job["runs-on"])
    ? job["runs-on"].join(" ")
    : job["runs-on"];
  if (typeof runners !== "string") {
    return undefined;
  }
  if (/windows/iu.test(runners)) {
    return 7;
  }
  return /ubuntu|macos/iu.test(runners) ? 3 : undefined;
};
const hasOwnedInstallTransition = (job: Record<string, unknown>) => {
  if (jobCachePolicy({ workflow: baseWorkflow, job }) !== "install-cache") {
    return false;
  }
  const inputs =
    v.parse(
      v.looseObject({
        steps: v.optional(
          v.array(
            v.looseObject({
              name: v.string(),
              uses: v.optional(v.string()),
              with: v.optional(v.record(v.string(), v.unknown())),
            }),
          ),
        ),
      }),
      job,
    ).steps ?? [];
  const setup = inputs.find(({ name }) => name === "Setup Bun");
  const install = inputs.find(({ name }) => name === "Install dependencies");
  if (
    setup === undefined ||
    usesOf(withoutActionRef(setup)) !== "oven-sh/setup-bun@<pinned>" ||
    install === undefined ||
    !scopedInstallActions.has(usesOf(install) ?? "")
  ) {
    return false;
  }
  const setupInputs = setup.with ?? {};
  const installInputs = install.with ?? {};
  return (
    Object.keys(setupInputs).length === 1 &&
    setupInputs["bun-version-file"] === "package.json" &&
    Object.keys(installInputs).length === 1 &&
    installInputs["flags"] === ownedInstallFlags
  );
};
// Normalize only the exact ordinary install-owner transition back to its
// merge-base setup and install steps. All step metadata remains significant.
const withInstallCache = (step: Step, job: Record<string, unknown>): Step => {
  if (!hasOwnedInstallTransition(job)) {
    return step;
  }
  if (
    step.name === "Setup Bun" &&
    usesOf(step) === "oven-sh/setup-bun@<pinned>"
  ) {
    const inputs = v.parse(
      v.looseObject({ with: v.optional(v.record(v.string(), v.unknown())) }),
      step,
    ).with;
    return {
      ...step,
      uses: "stella/.github/actions/setup-bun-cached@<pinned>",
      with: { ...inputs, save: `\${{ github.ref == 'refs/heads/main' }}` },
    };
  }
  if (
    step.name === "Install dependencies" &&
    scopedInstallActions.has(usesOf(step) ?? "")
  ) {
    const original = { ...step };
    delete original["uses"];
    delete original["with"];
    if (original["timeout-minutes"] === derivedInstallTimeout(job)) {
      delete original["timeout-minutes"];
    }
    original["run"] = "bash scripts/retry.sh bun ci --ignore-scripts";
    return original;
  }
  return step;
};
const withoutPreparedGeneration = (step: Step): Step => {
  if (
    step.name !== "CLI sharded registry and derived runtime guard" &&
    step.name !== "Content delivery declarations"
  ) {
    return step;
  }
  const { run } = v.parse(v.looseObject({ run: v.optional(v.string()) }), step);
  const prepared = "bun scripts/ci-generated-sources.ts prepare\n";
  const regeneration = [
    "set -euo pipefail",
    "bun scripts/ci-generated-sources.ts prepare",
    "# Regeneration guards intentionally modify inputs and report their diff.",
    "# Validate the artifact first, then use ordinary generation in this leg.",
    "unset CI_GENERATED_SOURCES_MANIFEST",
    `echo 'CI_GENERATED_SOURCES_MANIFEST=' >> "$GITHUB_ENV"`,
    "",
  ].join("\n");
  if (
    step.name === "CLI sharded registry and derived runtime guard" &&
    run?.startsWith(regeneration)
  ) {
    return {
      ...step,
      run: `bun apps/api/scripts/generate-capability-runtime.ts\n${run.slice(regeneration.length)}`,
    };
  }
  return run?.startsWith(prepared)
    ? {
        ...step,
        run: `bun apps/api/scripts/generate-capability-runtime.ts\n${run.slice(prepared.length)}`,
      }
    : step;
};
const PACKAGE_SCOPE = "needs.ci-plan.outputs.package_checks_required == 'true'";
const DOCUMENTATION_CHECKS = new Set([
  "Documentation source policy rule",
  "Instruction policy",
]);
// Documentation checks retain all prerequisites while widening beyond package scope.
const documentationScope = (step: Step): Step => {
  if (!DOCUMENTATION_CHECKS.has(step.name) || typeof step["if"] !== "string") {
    return step;
  }
  return { ...step, if: step["if"].replace(` && (${PACKAGE_SCOPE})`, "") };
};

// Per-test limits change scheduling budgets, not the check command or its inputs.
const withoutTestTimeout = (step: Step): Step => {
  const run = step["run"];
  if (typeof run !== "string") {
    return step;
  }
  return {
    ...step,
    run: run.replaceAll(
      /^(\s*bun (?:test|scripts\/run-unlisted-script-tests\.ts)) --timeout(?:=| )\d+\b/gmu,
      "$1",
    ),
  };
};

// Delegation drops only a family whose owning job runs the same check in this
// run, and an unchanged family only when the plan proves its paths untouched;
// scripts/generated-files-guard.test.ts binds each to its job's `if:` or plan.
const withoutDelegatedGeneratorChecks = (step: Step): Step => {
  const { env } = v.parse(
    v.looseObject({ env: v.optional(v.record(v.string(), v.unknown())) }),
    step,
  );
  if (
    step.name !== "Generated files manifest guard" ||
    env === undefined ||
    !(
      Object.hasOwn(env, DELEGATED_CHECKS_ENV) ||
      Object.hasOwn(env, UNCHANGED_CHECKS_ENV)
    )
  ) {
    return step;
  }
  const {
    [DELEGATED_CHECKS_ENV]: _delegated,
    [UNCHANGED_CHECKS_ENV]: _unchanged,
    ...environment
  } = env;
  const { env: _env, ...original } = step;
  return Object.keys(environment).length === 0
    ? original
    : { ...original, env: environment };
};

// A step deadline bounds a hung command; the step still fails when it fires,
// so it changes no coverage. With continue-on-error a fired deadline would
// pass silently, so those steps keep the timeout in the comparison.
const withoutStepTimeout = (step: Step): Step => {
  if (step["continue-on-error"] !== undefined) {
    return step;
  }
  const original = { ...step };
  delete original["timeout-minutes"];
  return original;
};

const LOCAL_CHECK_BASE_REF = `\${{ format('origin/{0}', github.base_ref || 'main') }}`;
const LOCAL_BASE_REF = `\${{ github.base_ref || 'main' }}`;
const CLI_CONTRACT_COMMAND = "bun scripts/check-cli-contract-changeset.ts";
const withoutLocalVerification = (step: Step): Step => {
  const { env, run } = v.parse(
    v.looseObject({
      env: v.optional(v.record(v.string(), v.unknown())),
      run: v.optional(v.string()),
    }),
    step,
  );
  if (
    env?.["STELLA_VERIFY"] !== "prepare" &&
    env?.["STELLA_VERIFY"] !== "check"
  ) {
    return step;
  }
  const environment = { ...env };
  delete environment["STELLA_VERIFY"];
  const original = { ...step };
  // Normalize the complete base-ref handoff; every other command and env survives.
  if (
    step.name === "CLI contract changeset guard" &&
    env["CHECK_BASE_REF"] === LOCAL_CHECK_BASE_REF &&
    env["BASE_REF"] === LOCAL_BASE_REF &&
    run === `${CLI_CONTRACT_COMMAND} --base "$CHECK_BASE_REF"`
  ) {
    delete environment["CHECK_BASE_REF"];
    original["run"] = `${CLI_CONTRACT_COMMAND} --base "origin/$BASE_REF"`;
  }
  if (Object.keys(environment).length === 0) {
    delete original["env"];
  } else {
    original["env"] = environment;
  }
  return original;
};

// Steps that chose their base from the pull request or merge-group event now
// read the planner's comparison base (the tip the pull request merged onto, or
// the target branch for a merge group). Mapping the merge-base form keeps every
// other field of those checks compared exactly.
const TARGET_BASE_REWRITES = new Map([
  [
    `\${{ github.event.pull_request.base.sha }}`,
    `\${{ needs.ci-plan.outputs.target_base_sha }}`,
  ],
  [
    `\${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || '' }}`,
    `\${{ needs.ci-plan.outputs.target_base_sha }}`,
  ],
  [
    `\${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}`,
    `\${{ needs.ci-plan.outputs.target_base_sha }}`,
  ],
  [
    `\${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.sha }}`,
    `\${{ needs.ci-plan.outputs.target_base_sha || github.sha }}`,
  ],
  [
    `\${{ github.event.merge_group.base_sha }}`,
    `\${{ github.event_name == 'merge_group' && needs.ci-plan.outputs.target_base_sha || '' }}`,
  ],
]);
const withTargetBase = (step: Step): Step => {
  const rewrite = (fields: unknown) =>
    fields !== null && typeof fields === "object"
      ? Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [
            key,
            typeof value === "string"
              ? (TARGET_BASE_REWRITES.get(value) ?? value)
              : value,
          ]),
        )
      : fields;
  return {
    ...step,
    ...(step["env"] === undefined ? {} : { env: rewrite(step["env"]) }),
    ...(step["with"] === undefined ? {} : { with: rewrite(step["with"]) }),
  };
};

// Checks that ran as background steps keep their ids in the check pool.
const formerBackgroundIds: Record<string, string> = {
  "Test capability shard merge and package parity": "capability_parity",
  "Generated files manifest guard": "generated_manifest",
  "Test api scripts": "api_scripts",
  "Test CLI runtime package parity": "cli_runtime_parity",
  "Test remaining repository scripts": "remaining_scripts",
  "Playwright config scope": "playwright_scope",
};
const ownedSteps = (steps: readonly Step[]) =>
  steps
    .filter(({ name }) => !prerequisites.has(name))
    .map(withTargetBase)
    .map(withoutLocalVerification)
    .map(documentationScope)
    .map(withoutContinuation)
    .map(withoutPreparedGeneration)
    .map(withoutTestTimeout)
    .map(withoutDelegatedGeneratorChecks)
    .map(withoutStepTimeout)
    .map(withoutStepId)
    .map((step) =>
      typeof step["run"] === "string"
        ? { ...step, run: normalizeGuardPathLines(step["run"], trackedFiles) }
        : step,
    )
    .map((step) => {
      const { background, ...check } = step;
      if (
        background !== true &&
        step["id"] !== formerBackgroundIds[step.name]
      ) {
        return step;
      }
      const { id: _id, ...command } = check;
      return command;
    })
    .map(withoutActionRef)
    .toSorted((left, right) => compareCodeUnit(left.name, right.name));

// YAML folding changes whitespace outside literals, not the condition's tokens.
const conditionTokens = (condition: string) =>
  condition
    .replaceAll(/'(?:[^']|'')*'|\s+/gu, (token) =>
      token.startsWith("'") ? token : " ",
    )
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u, "$1");
const QUICK_GATED_NEEDS = ["ci-plan", "generated-sources", "pr-heavy-gate"];
const QUICK_CHECK_GATE =
  "!cancelled() && needs.ci-plan.result == 'success' && needs.generated-sources.result == 'success' && (github.event_name != 'pull_request' || needs.ci-plan.outputs.pr_heavy_gate_required != 'true' || needs.pr-heavy-gate.result == 'success') && ";
type ScopeOptions = {
  current: Record<string, unknown>;
  base: Record<string, unknown>;
  job?: string | undefined;
  releaseHoldRemoved?: boolean;
};
const expectScope = ({
  current,
  base,
  job,
  releaseHoldRemoved,
}: ScopeOptions) => {
  const { if: gatedCondition, ...scope } = current;
  const { if: gatedOriginalCondition, ...originalScope } = base;
  // A leg that waits for the quick checks names their gate and, running past
  // `!cancelled()`, states its prerequisites itself. Compare the scope under
  // that exact prefix; a gated leg without it fails.
  const ungate = (target: Record<string, unknown>, value: unknown) => {
    if (!isDeepStrictEqual(target["needs"], QUICK_GATED_NEEDS)) {
      return value;
    }
    target["needs"] = ["ci-plan", "generated-sources"];
    const tokens = conditionTokens(v.parse(v.string(), value));
    expect(tokens.startsWith(QUICK_CHECK_GATE), tokens).toBe(true);
    return tokens.slice(QUICK_CHECK_GATE.length);
  };
  const condition = ungate(scope, gatedCondition);
  const originalCondition = ungate(originalScope, gatedOriginalCondition);
  // The generated-source producer is a job of its own, so its consumers
  // name both. A merge base may name the plan alone, the current producer, or
  // the retired producer that ran after the plan.
  if (isDeepStrictEqual(scope["needs"], ["ci-plan", "generated-sources"])) {
    scope["needs"] = "ci-plan";
  }
  if (
    isDeepStrictEqual(originalScope["needs"], [
      "ci-plan",
      "ci-generated-sources",
    ]) ||
    isDeepStrictEqual(originalScope["needs"], ["ci-plan", "generated-sources"])
  ) {
    originalScope["needs"] = "ci-plan";
  }
  // Jobs were pinned to ubuntu-24.04, the image ubuntu-latest resolved to, so
  // a merge base that still names the floating label runs the same image.
  if (
    originalScope["runs-on"] === "ubuntu-latest" &&
    scope["runs-on"] === "ubuntu-24.04"
  ) {
    originalScope["runs-on"] = "ubuntu-24.04";
  }
  const originalEnvironment =
    originalScope["env"] === undefined
      ? undefined
      : v.parse(v.record(v.string(), v.unknown()), originalScope["env"]);
  const hydrationDependency =
    originalScope["needs"] === "ci-plan" &&
    scope["needs"] === "ci-plan" &&
    !Object.hasOwn(
      originalEnvironment ?? {},
      "CI_GENERATED_SOURCES_MANIFEST",
    ) &&
    isDeepStrictEqual(scope["env"], {
      ...originalEnvironment,
      CI_GENERATED_SOURCES_MANIFEST: `\${{ github.workspace }}/.cache/ci-generated-sources/manifest.json`,
    });
  const migrated = { ...scope };
  // A check-pool matrix changes scheduling, not the inherited job scope.
  // Accept only the exact exhaustive two-way partition used by the runner;
  // arbitrary strategy changes remain visible to this comparison. Normalize
  // only an added partition: a baseline that owns it must retain it.
  if (
    job === "ci-checks-rest" &&
    originalScope["strategy"] === undefined &&
    isDeepStrictEqual(migrated["strategy"], {
      "fail-fast": false,
      matrix: { partition: [1, 2] },
    })
  ) {
    delete migrated["strategy"];
  }
  // The retired changeset hold was the check legs' only pull-request reader.
  if (
    job !== undefined &&
    ["ci-checks-generated", "ci-checks-policy", "ci-checks-rest"].includes(
      job,
    ) &&
    releaseHoldRemoved === true &&
    isDeepStrictEqual(originalScope["permissions"], {
      contents: "read",
      "pull-requests": "read",
    }) &&
    isDeepStrictEqual(scope["permissions"], { contents: "read" })
  ) {
    originalScope["permissions"] = { contents: "read" };
  }
  // Normalize only an added handoff. A baseline that owns it must retain it.
  if (hydrationDependency) {
    const { CI_GENERATED_SOURCES_MANIFEST: _added, ...environment } = v.parse(
      v.record(v.string(), v.unknown()),
      scope["env"],
    );
    if (originalEnvironment === undefined) {
      delete migrated["env"];
    } else {
      migrated["env"] = environment;
    }
  }
  expect(migrated).toEqual(originalScope);
  // Ordinary scope comparisons supply fresh-run evidence. Completion reuse
  // is exercised separately by the depth contract's true/false census. A
  // merge base may already carry the completion guard, so strip it from both.
  // PR-depth evidence guards are bound to their job set and merge-group
  // execution in ci-pr-depth-workflow.test.ts; compare the underlying scope.
  const freshScope = (value: unknown) => {
    const tokens = conditionTokens(v.parse(v.string(), value)).replace(
      /^(?:needs\.ci-plan\.outputs\.pr_depth_reused != 'true'|\(github\.event_name == 'merge_group' \|\| needs\.ci-plan\.outputs\.pr_depth_reused != 'true'\)) && /u,
      "",
    );
    return (
      /^needs\.ci-plan\.outputs\.run_required != 'false' && \(\s*(.*?)\s*\)$/u
        .exec(tokens)
        ?.at(1) ?? tokens
    );
  };
  const fresh = freshScope(condition);
  const original = freshScope(originalCondition);
  if (fresh === original || fresh === `${original} && ${PACKAGE_SCOPE}`) {
    return;
  }
  const wrapped = /^inputs\.heavy_only != true && \(\s*(.*?)\s*\)$/u.exec(
    fresh,
  );
  expect(wrapped?.at(1)).toBe(original);
};

type CoverageOptions = {
  current: readonly Step[];
  base: readonly Step[];
  removed: readonly string[];
};
const expectCoverage = ({ current, base, removed }: CoverageOptions) => {
  const actual = ownedSteps(current);
  const expected = ownedSteps(base);
  const removedNames = new Set(removed);
  expect(removedNames.size).toBe(removed.length);
  expect(new Set(actual.map(({ name }) => name)).size).toBe(actual.length);
  expect(new Set(expected.map(({ name }) => name)).size).toBe(expected.length);
  for (const name of removed) {
    expect(expected.map((step) => step.name)).toContain(name);
    expect(actual.map((step) => step.name)).not.toContain(name);
  }
  // Every merge-base check survives unchanged unless its removal is listed;
  // a new check is an addition, which needs no ledger entry.
  const expectedNames = new Set(expected.map(({ name }) => name));
  expect(actual.filter(({ name }) => expectedNames.has(name))).toEqual(
    expected.filter(({ name }) => !removedNames.has(name)),
  );
};
// Setup removals are owned by their leg, so repeated names cannot authorize
// removing another leg's protection implicitly.
const baselineIds = baseJobs["ci-checks"] ? ["ci-checks"] : partitionIds;
const normalizeRootSelection = (step: Step, job: string) => {
  const fields = v.parse(
    v.looseObject({
      if: v.optional(v.string()),
      env: v.optional(v.record(v.string(), v.unknown())),
    }),
    step,
  );
  const condition = fields.if;
  const suffix = ` && ${rootCheckGate({ job, name: step.name })}`;
  const tokens = condition?.replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u, "$1");
  const normalized = { ...step };
  // Base and head both normalize here; validateRootCheckCensus owns the
  // head's gate-to-declaration agreement, and a base gate may be removed.
  if (tokens?.endsWith(suffix)) {
    normalized["if"] = `\${{ ${tokens.slice(0, -suffix.length)} }}`;
  }
  return normalized;
};
const legSteps = (
  legs: readonly v.InferOutput<typeof headJobSchema>[],
  ids: readonly string[],
) =>
  legs.flatMap(({ steps }, index) => {
    const id = ids.at(index);
    if (!id) {
      panic("CI check leg has no identifier");
    }
    return steps.map((original) => {
      const step = normalizeRootSelection(original, id);
      return step.name === "Install Safe Chain"
        ? { ...step, name: `${id}: ${step.name}` }
        : step;
    });
  });
const actualSteps = legSteps(partitions, partitionIds);
const lintFixtureCommand = ["bun", ...customLintTestCommand().slice(1)].join(
  " ",
);
const stepFieldsSchema = v.looseObject({
  env: v.optional(v.unknown()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
});
const stepFields = (step: Step | undefined) =>
  v.parse(stepFieldsSchema, step ?? {});
const baseSteps = legSteps(baseline, baselineIds).map((step) => {
  const fields = stepFields(step);
  if (step.name === "CLI sharded registry and derived runtime guard") {
    const run = v.parse(v.string(), fields.run);
    const continuation = " \\";
    const anchor = `  packages/cli/src/generated/registry-snapshot.json${continuation}`;
    const additions = CI_GENERATED_OUTPUTS.cliRegistry
      .filter((output) => !run.includes(`  ${output}${continuation}`))
      .map((output) => `  ${output}${continuation}`)
      .join("\n");
    if (additions.length > 0) {
      expect(run).toContain(anchor);
      return Object.assign(step, {
        run: run.replace(anchor, () => `${anchor}\n${additions}`),
      });
    }
  }
  // These structural guards no longer own expiry, so their failures block
  // merge groups as well. Normalize only their former clock-based lenience.
  if (
    (step.name === "Dated waiver lifecycle guards" ||
      step.name === "Quarantine-exclude guards") &&
    step["continue-on-error"] === `\${{ github.event_name == 'merge_group' }}`
  ) {
    const original = { ...step };
    delete original["continue-on-error"];
    return original;
  }
  // Format checks the tracked tree with `bun fmt --check`; it no longer
  // filters by affected packages, so it no longer waits on that step.
  if (step.name === "Format" && fields.run?.includes("turbo run format")) {
    const { AFFECTED_FLAG: _flag, ...env } = v.parse(
      v.record(v.string(), v.unknown()),
      step["env"] ?? {},
    );
    return {
      ...step,
      env,
      if: fields.if?.replace(" && steps.affected.outcome == 'success'", ""),
      run: "bun fmt --check",
    };
  }
  // The classification check derives its manifest instead of reading a
  // committed one, and exposes its sensitive-change output by step id.
  if (
    step.name === "Check workflow job classifications" &&
    step["id"] === undefined
  ) {
    return { ...step, id: "job-classification" };
  }
  if (step.name === "Checkout workflow classification tooling") {
    const checkout = v.parse(
      v.looseObject({ "sparse-checkout": v.string() }),
      step["with"],
    );
    return {
      ...step,
      with: {
        ...checkout,
        "fetch-depth": 0,
        "sparse-checkout": checkout["sparse-checkout"].replace(
          ".github/ci-job-classification.json\n",
          "",
        ),
      },
    };
  }
  if (step.name === "Test release policy scripts" && fields.run !== undefined) {
    let run = fields.run;
    if (
      run.includes(
        "bun test scripts/check-release-cli-changeset-hold.test.ts\n",
      )
    ) {
      run = run
        .replace(
          "bun test scripts/check-release-cli-changeset-hold.test.ts\n",
          "bun test scripts/release-version-dispatch.test.ts\n",
        )
        .replace("bash scripts/release-pending.test.sh\n", "");
    }
    // A baseline before the release hold retired still carries its shell
    // suite. Normalize only that removed owner, never another release check.
    if (!trackedFiles.has("scripts/check-main-merge-hold.test.sh")) {
      run = run.replace("bash scripts/check-main-merge-hold.test.sh\n", "");
    }
    return { ...step, run };
  }
  if (
    step.name === "Test oxlint plugins" &&
    fields.run ===
      "bun test scripts/oxlint-plugin-test-coverage.test.ts\nbun scripts/run-custom-lint-tests.ts\n"
  ) {
    const coverage = stepFields(
      actualSteps.find(({ name }) => name === "Custom lint rule coverage"),
    );
    expect(coverage.run).toBe(
      "bun test scripts/check-oxlint-rule-coverage.test.ts\nbun scripts/check-oxlint-rule-coverage.ts\n",
    );
    expect(coverage.if).toBe(fields.if);
    return Object.assign(step, {
      run: "bun test scripts/oxlint-plugin-test-coverage.test.ts\n",
    });
  }
  const runnerMigrations = {
    "Typecheck-cost baseline guard": {
      before:
        'bun scripts/typecheck-baseline.ts --self-test\nbun test scripts/typecheck-baseline.test.ts\nbun scripts/typecheck-baseline.ts --check-delta "$RUNNER_TEMP/typecheck-base.json"\n',
      after:
        'bun scripts/typecheck-baseline.ts --self-test\nbun test scripts/typecheck-baseline.test.ts scripts/pre-push-policy.test.ts\nbun scripts/typecheck-baseline.ts --check-delta "$RUNNER_TEMP/typecheck-base.json"\n',
    },
    "Test oxlint plugins": {
      before:
        "bun test scripts/oxlint-plugin-test-coverage.test.ts\nfind ./.oxlint-plugins/__tests__ -maxdepth 1 -name '*.test.ts' -print0 | sort -z | xargs -0 bun test\n",
      after:
        "bun test scripts/oxlint-plugin-test-coverage.test.ts\nbun scripts/run-custom-lint-tests.ts\n",
    },
    "Test aggregate inventories": {
      before:
        "bun test scripts/check-aggregate-locks.test.ts scripts/check-aggregate-mutations.test.ts .oxlint-plugins/__tests__/aggregate-lock-sites.test.ts .oxlint-plugins/__tests__/confine-aggregate-lock.test.ts",
      after:
        "bun scripts/run-custom-lint-tests.ts scripts/check-aggregate-locks.test.ts scripts/check-aggregate-mutations.test.ts .oxlint-plugins/__tests__/aggregate-lock-sites.test.ts .oxlint-plugins/__tests__/confine-aggregate-lock.test.ts",
    },
    "Test write contract inventories": {
      before:
        "bun test scripts/check-write-contracts.test.ts .oxlint-plugins/__tests__/require-write-contract.test.ts",
      after:
        "bun scripts/run-custom-lint-tests.ts scripts/check-write-contracts.test.ts .oxlint-plugins/__tests__/require-write-contract.test.ts",
    },
  };
  const migration = Object.entries(runnerMigrations).find(
    ([name]) => name === step.name,
  )?.[1];
  if (migration !== undefined && fields.run === migration.before) {
    return Object.assign(step, { run: migration.after });
  }
  if (
    step.name !== "Documentation source policy rule" ||
    fields.run !== `${lintFixtureCommand}\nbun run check:docs-sources\n`
  ) {
    return step;
  }
  // The coverage owner now runs these fixtures and records their outcomes.
  const coverage = stepFields(
    actualSteps
      .map(withoutContinuation)
      .find(({ name }) => name === "Custom lint rule coverage"),
  );
  expect(coverage.if).toBe(fields.if);
  expect(coverage.run).toBe(
    "bun test scripts/check-oxlint-rule-coverage.test.ts\nbun scripts/check-oxlint-rule-coverage.ts\n",
  );
  expect(coverage.env).toEqual({
    BASE_SHA: `\${{ needs.ci-plan.outputs.target_base_sha }}`,
  });
  return Object.assign(step, { run: "bun run check:docs-sources" });
});

test("CI legs normalize only the complete canonical cancellation tail and its permission", () => {
  const guard = { name: "Guard", run: "bun check" };
  const cancellation = {
    ...CANONICAL_CANCEL_STEP,
    if: "failure() && github.event_name == 'merge_group'",
  };
  const base = { permissions: { contents: "read" }, steps: [guard] };
  const job = {
    permissions: { contents: "read", actions: "write" },
    steps: [guard, cancellation],
  };
  expect(v.parse(headJobSchema, job)).toEqual(base);
  for (const changed of [
    { ...cancellation, if: "failure()" },
    { ...cancellation, uses: "actions/github-script@main" },
    { ...cancellation, with: { ...cancellation.with, retries: 1 } },
    { ...cancellation, with: { ...cancellation.with, script: "exit 0" } },
    { ...cancellation, "continue-on-error": true },
  ]) {
    expect(
      v.parse(headJobSchema, { ...job, steps: [guard, changed] }),
    ).not.toEqual(base);
  }
  expect(
    v.parse(headJobSchema, { ...job, steps: [cancellation, guard] }),
  ).not.toEqual(base);
  expect(() =>
    v.parse(headJobSchema, {
      ...job,
      permissions: { contents: "read", actions: "read" },
    }),
  ).toThrow("toBe");
  expect(
    v.parse(headJobSchema, {
      ...job,
      permissions: { ...job.permissions, contents: "write" },
    }),
  ).not.toEqual(base);
});

test("the store cache save supervisor runs exactly once in the rest leg", () => {
  const command = "bun test scripts/ci-store-save.test.ts";
  const owners = partitions.flatMap(({ steps }, index) =>
    steps
      .filter((step) =>
        stepFields(step).run?.includes("scripts/ci-store-save.test.ts"),
      )
      .map((step) => ({
        leg: partitionIds.at(index),
        run: stepFields(step).run,
      })),
  );
  expect(owners).toEqual([{ leg: "ci-checks-rest", run: command }]);
});

test("parallel CI checks preserve every merge-base check exactly once", () => {
  expect(jobs).not.toHaveProperty("ci-checks");
  expect(new Set(removedChecks.map(({ name }) => name)).size).toBe(
    removedChecks.length,
  );
  expect(
    removedChecks.filter(({ name }) => baseRemovalNames.has(name)),
  ).toEqual(baseRemovals);
  expectCoverage({
    current: actualSteps,
    base: baseSteps,
    removed: newRemovals.map(({ name }) => name),
  });
});

test("code-quality pool preserves every moved check exactly once", () => {
  const movedNames = [
    "Code quality (web)",
    "Result consumption (web)",
    "Code quality (rest)",
    "Query cache types",
    "Dead columns",
    "Projection totality",
    "Aggregate ownership",
    "Split-button census",
    "Database awaits in loops",
    "Online unique index dependency guard",
    "API timeout mutation guard",
    "Result consumption (rest)",
  ];
  const withoutPoolMetadata = (step: Record<string, unknown>) => {
    const normalized = { ...step };
    // An expanded pooled check carries its generated budget as its timeout.
    delete normalized["timeout-minutes"];
    // An ordinary step's implicit success() is `!cancelled()` in the pool.
    if (normalized["if"] === ["$", "{{ !cancelled() }}"].join("")) {
      delete normalized["if"];
    } else if (typeof normalized["if"] === "string") {
      normalized["if"] = normalized["if"].replace(
        /^\$\{\{\s*([\s\S]*?)\s*\}\}$/u,
        "$1",
      );
    }
    const env = normalized["env"];
    if (typeof env === "object" && env !== null && !Array.isArray(env)) {
      const originalEnv = Object.fromEntries(
        Object.entries(env).filter(
          ([key]) =>
            !["CI_CHECK_KIND", "CI_CHECK_INPUTS", "CI_CHECK_CONTEXT"].includes(
              key,
            ),
        ),
      );
      if (Object.keys(originalEnv).length === 0) {
        delete normalized["env"];
      } else {
        normalized["env"] = originalEnv;
      }
    }
    return normalized;
  };

  // Before the move the merge base runs these checks inline; once it lands,
  // the base schema expands the base pool. Either way the head's pool
  // preserves the base's checks.
  const originals = v
    .parse(headJobSchema, baseJobs["code-quality-web-rest"])
    .steps.filter(({ name }) => movedNames.includes(name))
    .map(withoutPoolMetadata);
  const pooled = readCheckPool("code-quality-web-rest").map(({ step }) => step);

  expect(pooled.map(({ name }) => name)).toEqual(movedNames);
  // A merge base may already carry the pool; normalize both sides alike.
  expect(pooled.map(withoutPoolMetadata)).toEqual(
    originals.map(withoutPoolMetadata),
  );
});

// A migration-shape test that reads the old shape from the merge base fails
// main once its own migration lands there. Every test here must also pass
// with the head as its own base.
test.skipIf(process.env["CI_CHECKS_PARTITION_BASE"] !== undefined)(
  "every partition test also holds once its migration is on the base",
  () => {
    const run = Bun.spawnSync(
      ["bun", "test", "./scripts/ci-checks-partition.test.ts"],
      {
        cwd: repository,
        env: { ...process.env, CI_CHECKS_PARTITION_BASE: "HEAD" },
      },
    );
    expect(run.stderr.toString()).toContain(" 0 fail");
    expect(run.exitCode).toBe(0);
  },
  60_000,
);

test("task result cache checks belong exactly once to the rest leg", () => {
  const checks = partitions.flatMap(({ steps }, index) =>
    ownedSteps(
      steps.map((step) =>
        normalizeRootSelection(step, partitionIds.at(index) ?? ""),
      ),
    )
      .filter(
        ({ run }) =>
          typeof run === "string" &&
          run.includes("scripts/task-result-cache.test.ts"),
      )
      .map((step) => ({ leg: partitionIds.at(index), step })),
  );
  expect(checks).toEqual([
    {
      leg: "ci-checks-rest",
      step: {
        name: "Task result cache contract",
        if: PACKAGE_SCOPE,
        run: "bun test scripts/task-result-cache.test.ts",
      },
    },
  ]);
});

test("each CI check leg preserves merge-base setup, supply-chain protection and scope", () => {
  const result = v.parse(
    v.looseObject({
      needs: v.array(v.string()),
      steps: v.array(
        v.looseObject({ env: v.optional(v.record(v.string(), v.string())) }),
      ),
    }),
    jobs["ci-result"],
  );
  expect(result.needs).toContain("dependency-malware");
  const scopes = result.steps.find(({ env }) => env?.["JOB_SCOPES"])?.env?.[
    "JOB_SCOPES"
  ];
  expect(
    v.parse(
      v.record(v.string(), v.nullable(v.string())),
      JSON.parse(v.parse(v.string(), scopes)),
    )["dependency-malware"],
  ).toBe("dependency_malware_required");
  expect(
    v.parse(v.looseObject({ if: v.string() }), jobs["dependency-malware"]).if,
  ).toContain("needs.ci-plan.outputs.dependency_malware_required == 'true'");
  for (const [index, partition] of partitions.entries()) {
    const base = baseJobs["ci-checks"] ? baseline.at(0) : baseline.at(index);
    if (!base) {
      panic("CI check leg has no merge-base setup");
    }
    const {
      steps: originalSteps,
      "timeout-minutes": originalTimeout,
      ...originalScope
    } = base;
    const { steps, "timeout-minutes": timeout, ...scope } = partition;
    const originalSetup = setupSteps(originalSteps)
      .map(withTaskResultCacheSetup)
      .map(withPrDepthCheckoutRef)
      .map((step) => withInstallCache(step, base))
      .map((step) => {
        if (
          partitionIds.at(index) !== "ci-checks-policy" ||
          step.name !== "Install dependencies" ||
          step["if"] !== PACKAGE_SCOPE
        ) {
          return step;
        }
        const widened = { ...step };
        delete widened["if"];
        return widened;
      });
    if (!baseJobs["ci-checks"]) {
      const baseNames = new Set(originalSteps.map(({ name }) => name));
      // Pooled checks run concurrently; their registry order is not a schedule.
      const leg = partitionIds.at(index);
      const reordered = new Set(
        leg === "ci-checks-policy" || leg === "ci-checks-rest"
          ? readCheckPool(leg).map(({ name }) => name)
          : [],
      );
      if (partitionIds.at(index) === "ci-checks-rest") {
        reordered.add("Prepare environment");
        reordered.add("Content delivery declarations");
        reordered.add("Test release image CI gate");
        // Runs in the foreground beside the first background pair.
        reordered.add("Test oxlint plugins");
      }
      expect(
        steps
          .filter(
            ({ name }) =>
              baseNames.has(name) &&
              !preparationSteps.has(name) &&
              !reordered.has(name),
          )
          .map(({ name }) => name),
      ).toEqual(
        originalSteps
          .filter(
            ({ name }) =>
              !preparationSteps.has(name) &&
              !reordered.has(name) &&
              !newRemovals.some((removed) => removed.name === name),
          )
          .map(({ name }) => name),
      );
    }
    expect(originalSetup).toHaveLength(setupPrerequisites.size);
    expectScope({
      current: scope,
      base: originalScope,
      job: partitionIds.at(index),
      releaseHoldRemoved:
        baseSteps.some(({ name }) => name === "Release CLI changeset hold") &&
        !actualSteps.some(({ name }) => name === "Release CLI changeset hold"),
    });
    // While the merge base still runs typecheck-baseline as its own job, the
    // generated leg that absorbs it carries both budgets.
    const absorbedBaseline = baseJobs["typecheck-baseline"];
    const absorbedTimeout =
      partitionIds.at(index) === "ci-checks-generated" && absorbedBaseline
        ? v.parse(
            v.looseObject({ "timeout-minutes": v.number() }),
            absorbedBaseline,
          )["timeout-minutes"]
        : 0;
    const baselineBudget =
      v.parse(v.number(), originalTimeout) + absorbedTimeout;
    // Full version-change parity measured 15m in addition to the existing
    // 25m repository-check budget; later merge bases retain that allowance.
    const expectedBudget =
      partitionIds.at(index) === "ci-checks-rest" &&
      steps.some(
        ({ name }) => name === "Typecheck parity (all checked projects)",
      )
        ? Math.max(baselineBudget, 40)
        : baselineBudget;
    expect(timeout).toBe(expectedBudget);
    expect(
      setupSteps(steps).map((step) => withInstallCache(step, partition)),
    ).toEqual(originalSetup);
    const installIndex = steps.findIndex(
      ({ name }) => name === "Install dependencies",
    );
    expect(steps.findIndex(({ name }) => name === "Setup Bun")).toBeLessThan(
      installIndex,
    );
    const installStep = steps.at(installIndex);
    expect(
      installStep === undefined
        ? undefined
        : withInstallCache(installStep, partition)["run"],
    ).toBe("bash scripts/retry.sh bun ci --ignore-scripts");
  }
});

test("retiring the release hold removes only its check legs' pull-request read permission", () => {
  const base = {
    if: "needs.ci-plan.outputs.trusted == 'true'",
    permissions: { contents: "read", "pull-requests": "read" },
  };
  const current = { ...base, permissions: { contents: "read" } };
  for (const job of [
    "ci-checks-generated",
    "ci-checks-policy",
    "ci-checks-rest",
  ]) {
    expectScope({ current, base, job, releaseHoldRemoved: true });
    for (const permissions of [
      { contents: "write" },
      {},
      { contents: "read", issues: "read" },
    ]) {
      expect(() =>
        expectScope({
          current: { ...current, permissions },
          base,
          job,
          releaseHoldRemoved: true,
        }),
      ).toThrow("toEqual");
    }
  }
  expect(() =>
    expectScope({ current, base, job: "other-job", releaseHoldRemoved: true }),
  ).toThrow("toEqual");
  expect(() => expectScope({ current, base, job: "ci-checks-rest" })).toThrow(
    "toEqual",
  );
});

test("CI check scope permits only the heavy-only wrapper around the unchanged condition", () => {
  const base = {
    if: "needs.ci-plan.outputs.trusted == 'true' || github.event_name == 'workflow_dispatch'",
    needs: "ci-plan",
    permissions: { contents: "read" },
    "runs-on": "ubuntu-latest",
  };
  const wrapped = {
    ...base,
    if: `inputs.heavy_only != true && (\n ${base.if}\n )`,
  };
  expectScope({ current: base, base });
  expectScope({ current: wrapped, base });
  expectScope({
    current: {
      ...wrapped,
      env: {
        CI_GENERATED_SOURCES_MANIFEST: `\${{ github.workspace }}/.cache/ci-generated-sources/manifest.json`,
      },
    },
    base,
  });
  for (const condition of [
    `inputs.heavy_only == true && (${base.if})`,
    `inputs.heavy_only != true || (${base.if})`,
    `inputs.heavy_only != true && ${base.if}`,
    `inputs.heavy_only != true && (${base.if} || true)`,
    `inputs.heavy_only != true && (${base.if.replace("trusted", "other")})`,
    `inputs.heavy_only != true && (${base.if.replace("workflow_dispatch", "push")})`,
    `(${base.if}) && inputs.heavy_only != true`,
    `inputs.heavy_ only != true && (${base.if})`,
    `inputs.heavy_only != true && (${base.if.replace("trusted", "trus ted")})`,
  ]) {
    expect(() =>
      expectScope({ current: { ...wrapped, if: condition }, base }),
    ).toThrow("Expected:");
  }
  const mutations = [
    { ...wrapped, needs: [] },
    { ...wrapped, needs: ["ci-generated-sources"] },
    { ...wrapped, needs: ["ci-plan", "unrelated"] },
    { ...wrapped, needs: ["ci-plan", "ci-generated-sources"] },
    { ...wrapped, permissions: { contents: "write" } },
    { ...wrapped, "runs-on": "self-hosted" },
    { ...wrapped, "continue-on-error": true },
  ];
  for (const current of mutations) {
    expect(() => expectScope({ current, base })).toThrow("toEqual");
  }
  const { if: omitted, ...missingCondition } = wrapped;
  expect(omitted).toBe(wrapped.if);
  expect(() => expectScope({ current: missingCondition, base })).toThrow(
    "Invalid type",
  );
});

test("scope comparisons preserve queued certification and the underlying trust gate", () => {
  const scope =
    "inputs.heavy_only != true && ( needs.ci-plan.outputs.trusted == 'true' || github.event_name == 'workflow_dispatch' )";
  const reused = "needs.ci-plan.outputs.pr_depth_reused != 'true'";
  const queued = `(github.event_name == 'merge_group' || ${reused})`;
  const current = {
    if: `${queued} && needs.ci-plan.outputs.run_required != 'false' && (${scope})`,
  };
  for (const prefix of ["", `${reused} && `, `${queued} && `]) {
    expectScope({ current, base: { if: `${prefix}${scope}` } });
  }
  for (const condition of [
    current.if.replace("merge_group", "pull_request"),
    current.if.replace(
      " || needs.ci-plan.outputs.pr_depth_reused",
      " && needs.ci-plan.outputs.pr_depth_reused",
    ),
    current.if.replace("trusted == 'true'", "trusted != 'true'"),
    current.if.replace("workflow_dispatch", "push"),
  ]) {
    expect(() =>
      expectScope({ current: { if: condition }, base: { if: scope } }),
    ).toThrow("Expected:");
  }
});

test("a leg that waits for the quick checks keeps its scope and every prerequisite", () => {
  const scope =
    "needs.ci-plan.outputs.run_required != 'false' && ( inputs.heavy_only != true )";
  const base = { if: scope, needs: ["ci-plan", "generated-sources"] };
  const gated = { if: `${QUICK_CHECK_GATE}${scope}`, needs: QUICK_GATED_NEEDS };
  expectScope({ base, current: gated });
  expectScope({ base: gated, current: gated });
  for (const condition of [
    gated.if.replace(" && needs.generated-sources.result == 'success'", ""),
    gated.if.replace("needs.ci-plan.result == 'success' && ", ""),
    gated.if.replace("!cancelled() && ", "always() && "),
    scope,
  ]) {
    expect(() =>
      expectScope({ base, current: { ...gated, if: condition } }),
    ).toThrow("Expected:");
  }
  expect(() =>
    expectScope({ base, current: { ...gated, needs: ["ci-plan"] } }),
  ).toThrow("toEqual");
});

test("package scope narrows check legs while retaining baseline trust and completion gates", () => {
  const trust =
    "inputs.heavy_only != true && ( needs.ci-plan.outputs.trusted == 'true' || github.event_name == 'workflow_dispatch' )";
  for (const completion of [false, true]) {
    const wrap = (scope: string) =>
      completion
        ? `needs.ci-plan.outputs.run_required != 'false' && (${scope})`
        : scope;
    const base = {
      if: wrap(trust),
      needs: "ci-plan",
    };
    const narrowed = { ...base, if: wrap(`${trust} && ${PACKAGE_SCOPE}`) };
    expectScope({ base, current: narrowed });
    expectScope({ base: narrowed, current: narrowed });
    for (const suffix of [
      " || true",
      " && needs.ci-plan.outputs.other == 'true'",
      ` && ${PACKAGE_SCOPE} && needs.ci-plan.outputs.unapproved == 'true'`,
      " && needs.ci-plan.outputs.package_checks_required != 'true'",
    ]) {
      expect(() =>
        expectScope({
          base,
          current: { ...base, if: wrap(`${trust}${suffix}`) },
        }),
      ).toThrow("Expected:");
    }
    if (completion) {
      for (const invalid of [
        wrap(
          `${trust.replace("inputs.heavy_only != true && ", "")} && ${PACKAGE_SCOPE}`,
        ),
      ]) {
        expect(() =>
          expectScope({ base, current: { ...base, if: invalid } }),
        ).toThrow("Expected:");
      }
    }
  }
});

test("fresh scope compares either completion wrapper while retaining the underlying condition", () => {
  const trusted = "needs.ci-plan.outputs.trusted == 'true'";
  const heavy = `inputs.heavy_only != true && (${trusted})`;
  const completion = (scope: string) =>
    `needs.ci-plan.outputs.run_required != 'false' && (${scope})`;
  for (const scope of [trusted, heavy]) {
    for (const baseScope of [scope, completion(scope)]) {
      for (const currentScope of [scope, completion(scope)]) {
        expectScope({ base: { if: baseScope }, current: { if: currentScope } });
      }
      for (const invalid of [
        "true",
        completion("true"),
        completion(completion(scope)),
        completion(scope).replace("!= 'false'", "== 'false'"),
        completion(`${scope} && needs.ci-plan.outputs.unapproved == 'true'`),
        ...(scope === heavy ? [trusted, completion(trusted)] : []),
      ]) {
        expect(() =>
          expectScope({ base: { if: baseScope }, current: { if: invalid } }),
        ).toThrow("Expected:");
      }
    }
  }
});

test("CI check scope migrates only the complete producer handoff and preserves an existing handoff", () => {
  for (const environment of [
    undefined,
    {},
    { REQUIRED_SETTING: "unchanged" },
  ]) {
    const base = {
      if: "needs.ci-plan.outputs.trusted == 'true'",
      needs: "ci-plan",
      ...(environment === undefined ? {} : { env: environment }),
      permissions: { contents: "read" },
      "runs-on": "ubuntu-latest",
    };
    const handoff = {
      ...base,
      env: {
        ...environment,
        CI_GENERATED_SOURCES_MANIFEST: `\${{ github.workspace }}/.cache/ci-generated-sources/manifest.json`,
      },
    };
    expectScope({ current: handoff, base });
    expectScope({ current: handoff, base: handoff });
    expectScope({
      current: {
        ...handoff,
        if: `inputs.heavy_only != true && (${handoff.if})`,
      },
      base: handoff,
    });
    const incomplete = [
      { ...handoff, needs: ["ci-plan", "unrelated"] },
      { ...handoff, needs: ["ci-generated-sources", "ci-plan"] },
      { ...handoff, needs: ["ci-plan", "ci-generated-sources"] },
      {
        ...handoff,
        env: { ...handoff.env, CI_GENERATED_SOURCES_MANIFEST: "different" },
      },
      { ...handoff, env: { ...handoff.env, UNRELATED_SETTING: "added" } },
    ];
    for (const current of incomplete) {
      expect(() => expectScope({ current, base })).toThrow("toEqual");
      expect(() => expectScope({ current, base: handoff })).toThrow("toEqual");
    }
    expect(() => expectScope({ current: base, base: handoff })).toThrow(
      "toEqual",
    );
  }
});

test("producer scope regression rejects a mutation that normalizes an already-owned handoff", () => {
  const source = expectScope.toString();
  const mutant = source.replace(/if\s*\(hydrationDependency\)/u, "if (true)");
  expect(mutant).not.toBe(source);
  const handoff = {
    if: "needs.ci-plan.outputs.trusted == 'true'",
    needs: "ci-plan",
    env: {
      CI_GENERATED_SOURCES_MANIFEST: `\${{ github.workspace }}/.cache/ci-generated-sources/manifest.json`,
    },
  };
  expectScope({ current: handoff, base: handoff });
  expect(() =>
    runInContext(
      `(${mutant})(options)`,
      createContext({
        expect,
        v,
        isDeepStrictEqual,
        conditionTokens,
        QUICK_CHECK_GATE,
        QUICK_GATED_NEEDS,
        options: { current: handoff, base: handoff },
      }),
    ),
  ).toThrow("toEqual");
});

test("CI check scope preserves whitespace inside quoted condition values", () => {
  const base = { if: "github.event_name == 'workflow dispatch'" };
  expectScope({
    current: {
      if: "inputs.heavy_only != true && ( github.event_name == 'workflow dispatch' )",
    },
    base,
  });
  expect(() =>
    expectScope({
      current: {
        if: "inputs.heavy_only != true && (github.event_name == 'workflow  dispatch')",
      },
      base,
    }),
  ).toThrow("Expected:");
});

test("CI coverage ignores untracked guard paths on either side of the comparison", () => {
  expect(trackedFiles.has(workflowPath)).toBe(true);
  for (const path of [
    "untracked-base-output.json",
    "untracked-head-output.json",
  ]) {
    expect(trackedFiles.has(path)).toBe(false);
  }
  expectCoverage({
    base: [
      {
        name: "Generated output check",
        run: [
          "git diff --exit-code -- \\",
          "  untracked-base-output.json \\",
          `  ${workflowPath}`,
        ].join("\n"),
      },
    ],
    current: [
      {
        name: "Generated output check",
        run: [
          "git diff --exit-code -- \\",
          `  ${workflowPath} \\`,
          "  untracked-head-output.json",
        ].join("\n"),
      },
    ],
    removed: [],
  });
});

test("CI coverage rejects removal of a tracked guard path", () => {
  const path = "scripts/generated-files.ts";
  expect(trackedFiles.has(workflowPath)).toBe(true);
  expect(trackedFiles.has(path)).toBe(true);
  expect(() =>
    expectCoverage({
      base: [
        {
          name: "Generated output check",
          run: [
            "git diff --exit-code -- \\",
            `  ${workflowPath} \\`,
            `  ${path}`,
          ].join("\n"),
        },
      ],
      current: [
        {
          name: "Generated output check",
          run: ["git diff --exit-code -- \\", `  ${workflowPath}`].join("\n"),
        },
      ],
      removed: [],
    }),
  ).toThrow("toEqual");
});

test("guard normalization preserves directories, glob coverage and nonliteral commands", () => {
  const tracked = new Set(["generated/kept.json"]);
  const guarded = [
    "git diff --exit-code -- \\",
    "  generated \\",
    '  "generated/*.json" \\',
    "  untracked-output.json",
  ].join("\n");
  expect(normalizeGuardPathLines(guarded, tracked)).toBe(
    [
      "git diff --exit-code -- \\",
      "  generated \\",
      '  "generated/*.json"',
    ].join("\n"),
  );
  expect(
    normalizeGuardPathLines(
      ["git diff --exit-code -- \\", "  untracked-output.json"].join("\n"),
      tracked,
    ),
  ).not.toBe("git diff --exit-code --");
  const commands = [
    "echo untracked-output.json",
    "git diff --exit-code -- \\",
    '  "$GENERATED_OUTPUT"',
    "echo done",
  ].join("\n");
  expect(normalizeGuardPathLines(commands, tracked)).toBe(commands);
});

test("CI coverage rejects a dropped check and accepts only an explicitly listed removal", () => {
  const step = ownedSteps(baseSteps).at(0);
  if (!step) {
    panic("Merge-base CI checks contain no checks");
  }
  const dropped = baseSteps.filter(({ name }) => name !== step.name);
  expect(dropped.length).toBe(baseSteps.length - 1);
  expect(() =>
    expectCoverage({ current: dropped, base: baseSteps, removed: [] }),
  ).toThrow("toEqual");
  expectCoverage({ current: dropped, base: baseSteps, removed: [step.name] });
});

test("CI coverage accepts a new check alongside every merge-base check", () => {
  const added = { name: "A newly added check", run: "bun test new.test.ts" };
  expectCoverage({
    current: [...baseSteps, added],
    base: baseSteps,
    removed: [],
  });
  const step = ownedSteps(baseSteps).at(0);
  if (!step) {
    panic("Merge-base CI checks contain no checks");
  }
  const renamed = baseSteps.map((current) =>
    current.name === step.name
      ? { ...current, name: `${step.name} (renamed)` }
      : current,
  );
  expect(() =>
    expectCoverage({ current: renamed, base: baseSteps, removed: [] }),
  ).toThrow("toEqual");
});

const otherSha = "0".repeat(40);
const pinnedAction = (
  steps: readonly Step[],
  names: (name: string) => boolean,
) => {
  const step = steps.find(
    (current) => names(current.name) && PINNED_REF.test(usesOf(current) ?? ""),
  );
  const uses = step === undefined ? undefined : usesOf(step);
  if (step === undefined || uses === undefined) {
    panic("Merge-base CI checks contain no SHA-pinned action step");
  }
  const withUses = (next: string) =>
    steps.map((current) =>
      current.name === step.name ? { ...current, uses: next } : current,
    );
  return { action: uses.replace(PINNED_REF, ""), withUses };
};

test("CI coverage accepts a pinned action bump but not a different action or a mutable ref", () => {
  const { action, withUses } = pinnedAction(
    baseSteps,
    (name) => !prerequisites.has(name),
  );
  expectCoverage({
    current: withUses(`${action}@${otherSha}`),
    base: baseSteps,
    removed: [],
  });
  for (const changed of [
    `${action}-other@${otherSha}`,
    `${action}@main`,
    `${action}@v1`,
  ]) {
    expect(
      () =>
        expectCoverage({
          current: withUses(changed),
          base: baseSteps,
          removed: [],
        }),
      changed,
    ).toThrow("toEqual");
  }
});

test("each leg's setup accepts a pinned action bump but not a mutable ref", () => {
  const leg = partitions.at(0);
  if (!leg) {
    panic("CI checks have no legs");
  }
  const { action, withUses } = pinnedAction(leg.steps, (name) =>
    setupPrerequisites.has(name),
  );
  expect(setupSteps(withUses(`${action}@${otherSha}`))).toEqual(
    setupSteps(leg.steps),
  );
  expect(setupSteps(withUses(`${action}@main`))).not.toEqual(
    setupSteps(leg.steps),
  );
});

test("CI coverage rejects duplicate and modified checks", () => {
  const step = ownedSteps(baseSteps).at(0);
  if (!step) {
    panic("Merge-base CI checks contain no checks");
  }
  expect(() =>
    expectCoverage({
      current: [...baseSteps, step],
      base: baseSteps,
      removed: [],
    }),
  ).toThrow("toBe");
  const modified = baseSteps.map((current) =>
    current.name === step.name ? { ...current, run: "exit 0" } : current,
  );
  expect(modified).not.toEqual(baseSteps);
  expect(() =>
    expectCoverage({ current: modified, base: baseSteps, removed: [] }),
  ).toThrow("toEqual");
});

test("the baseline accepts the monolithic job and derives later split baselines", () => {
  const monolithic = readBaseline({ "ci-checks": baseline.at(0) });
  expect(monolithic).toHaveLength(1);
  const split = readBaseline(jobs);
  expect(split).toEqual(partitions);
  expectCoverage({
    current: legSteps(split, partitionIds),
    base: actualSteps,
    removed: [],
  });
});

test("unrelated jobs may use unnamed steps or reusable workflows", () => {
  const parsed = v.parse(workflowSchema, {
    jobs: {
      unrelated: { steps: [{ run: "exit 0" }] },
      reusable: { uses: "./.github/workflows/other.yml" },
      ...jobs,
    },
  });
  expect(readBaseline(parsed.jobs)).toEqual(partitions);
});

test("the check census preserves nested commands and their failure conditions", () => {
  const step = {
    name: "Independent guard",
    if: "!cancelled() && steps.install.outcome == 'success'",
    run: "bun test scripts/ci-plan.test.ts",
  };
  const serial = v.parse(headJobSchema, { steps: [step] });
  const concurrent = v.parse(headJobSchema, {
    steps: [
      {
        parallel: [{ parallel: [{ ...step, id: "guard", background: true }] }],
      },
      { "wait-all": null },
    ],
  });
  expect(ownedSteps(concurrent.steps)).toEqual(ownedSteps(serial.steps));
  expect(concurrent.steps.at(0)?.["if"]).toBe(step.if);
  expect(
    ownedSteps(
      v.parse(headJobSchema, {
        steps: [{ parallel: [{ ...step, run: "exit 0" }] }],
      }).steps,
    ),
  ).not.toEqual(ownedSteps(serial.steps));
});

test("repository checks run in one pool after preparation and before receipts", () => {
  for (const job of ["ci-checks-policy", "ci-checks-rest"] as const) {
    const raw = v.parse(v.object({ steps: v.unknown() }), jobs[job]);
    const steps = flattenWorkflowSteps(raw.steps);
    // The pool bounds concurrency itself; no native background step remains.
    expect(
      steps.filter(
        (step) => step["background"] === true || isWorkflowBarrier(step),
      ),
    ).toEqual([]);
    const pool = steps.findIndex(
      (step) => step["name"] === CHECK_POOL_STEP_NAMES[job],
    );
    expect(pool, job).toBeGreaterThan(0);
    expect(steps[pool]?.["continue-on-error"]).toBeUndefined();
    for (const name of [
      "Checkout",
      "Setup Bun",
      "Resolve static check receipts",
      "Install dependencies",
      "Download generated sources",
      "Restore generated sources",
      "Prepare environment",
    ]) {
      const index = steps.findIndex((step) => step["name"] === name);
      expect(index, name).toBeGreaterThanOrEqual(0);
      expect(index, name).toBeLessThan(pool);
    }
    for (const name of [
      "Record static check receipts",
      CANONICAL_CANCEL_STEP.name,
    ]) {
      expect(
        steps.findIndex((step) => step["name"] === name),
        name,
      ).toBeGreaterThan(pool);
    }
  }
});

const CONTENDED_TEST_TIMEOUTS = {
  "Test capability shard merge and package parity": 400_000,
  "Test remaining repository scripts": 35_000,
  "Test release image CI gate": 50_000,
  "Test api scripts": 12_000,
  "Test CLI runtime package parity": 80_000,
  "Playwright config scope": 5000,
} as const;

const backgroundTimeoutSteps = (raw: unknown): Step[] =>
  v.parse(
    v.array(v.looseObject({ name: v.string() })),
    v.parse(v.array(v.record(v.string(), v.unknown())), raw).flatMap((step) =>
      "parallel" in step
        ? flattenWorkflowSteps(step["parallel"]).map((child) => ({
            ...child,
            background: true,
          }))
        : flattenWorkflowSteps([step]),
    ),
  );

const assertExplicitBackgroundTestTimeouts = (steps: readonly Step[]) => {
  for (const step of steps) {
    const run = step["run"];
    if (typeof run !== "string") {
      continue;
    }
    const invocations = [...run.matchAll(/\bbun test\b[^\n]*/gu)];
    if (step["background"] === true) {
      for (const invocation of invocations) {
        expect(invocation[0], step.name).toMatch(
          /\bbun test --timeout(?:=| )[1-9]\d*\b/u,
        );
      }
    }
  }
};

const assertBackgroundTestTimeouts = (steps: readonly Step[]) => {
  assertExplicitBackgroundTestTimeouts(steps);
  for (const [name, timeout] of Object.entries(CONTENDED_TEST_TIMEOUTS)) {
    const step = steps.find((entry) => entry.name === name);
    expect(step, name).toBeDefined();
    expect(step?.["run"], name).toContain(`--timeout ${timeout}`);
  }
};

test("background Bun tests declare measured contention budgets without changing checks", () => {
  const steps = backgroundTimeoutSteps(
    v.parse(v.object({ steps: v.unknown() }), jobs["ci-checks-rest"]).steps,
  );
  assertBackgroundTestTimeouts(steps);
  for (const name of Object.keys(CONTENDED_TEST_TIMEOUTS)) {
    const missing = steps.map((step) =>
      step.name === name && typeof step["run"] === "string"
        ? { ...step, run: step["run"].replace(/ --timeout \d+\b/gu, "") }
        : step,
    );
    expect(() => assertBackgroundTestTimeouts(missing)).toThrow(name);
  }
  expect(
    withoutTestTimeout({
      name: "Check",
      run: "bun test --timeout 35000 scripts/example.test.ts",
    }),
  ).toEqual({ name: "Check", run: "bun test scripts/example.test.ts" });
  expect(
    withoutTestTimeout({ name: "Check", run: "echo --timeout 35000" }),
  ).toEqual({ name: "Check", run: "echo --timeout 35000" });
});

test("implicit nested parallel tests cannot omit their contention timeout", () => {
  const command = {
    name: "Nested test",
    run: "bun test scripts/example.test.ts",
  };
  expect(() =>
    assertExplicitBackgroundTestTimeouts(
      backgroundTimeoutSteps([{ parallel: [{ parallel: [command] }] }]),
    ),
  ).toThrow(command.name);
  assertExplicitBackgroundTestTimeouts(
    backgroundTimeoutSteps([
      {
        parallel: [
          {
            ...command,
            run: "bun test --timeout 5000 scripts/example.test.ts",
          },
        ],
      },
    ]),
  );
});

const expectContinuation = (steps: readonly Step[], leg: string) => {
  const installIndex = steps.findIndex(
    ({ name }) => name === "Install dependencies",
  );
  expect(installIndex).toBeGreaterThan(0);
  expect(steps.find(({ name }) => name === "Checkout")?.["id"]).toBe(
    "checkout",
  );
  expect(steps.at(installIndex)?.["id"]).toBe("install");
  for (const [index, step] of steps.entries()) {
    if (step.name === "Checkout") {
      continue;
    }
    if (leg === "ci-checks-rest" && preInstallGuards.has(step.name)) {
      expect(index, preInstallGuards.get(step.name)).toBeLessThan(installIndex);
      expect(step["id"]).toBe(stepIds[step.name]);
    }
    const { if: condition, "continue-on-error": continueOnError } = v.parse(
      v.looseObject({
        if: v.string(),
        "continue-on-error": v.optional(v.unknown()),
      }),
      step,
    );
    const original = withoutContinuation(step);
    const packageDependent =
      typeof original["if"] === "string" &&
      original["if"].includes(
        "needs.ci-plan.outputs.package_checks_required == 'true'",
      );
    let prefix: string = CONTINUATION_PREFIXES.checkout;
    if (index > installIndex) {
      prefix =
        packageDependent || DOCUMENTATION_CHECKS.has(step.name)
          ? CONTINUATION_PREFIXES.installPackages
          : CONTINUATION_PREFIXES.install;
    }
    expect(condition.startsWith(prefix), step.name).toBe(true);
    expect(withoutContinuation(step), step.name).not.toEqual(step);
    if (step.name === "Install dependencies") {
      const safety = leg === "ci-checks-rest" ? SAFETY_SUFFIX : "";
      expect(condition).toBe(
        `${CONTINUATION_PREFIXES.checkout}${leg === "ci-checks-policy" ? "" : ` && (${PACKAGE_SCOPE})`}${safety} }}`,
      );
    }
    expect(continueOnError, step.name).toBe(gateLenience(step.name));
  }
};

test("every independent CI guard continues only after successful prerequisites", () => {
  for (const [index, partition] of partitions.entries()) {
    const id = partitionIds.at(index);
    if (id === undefined) {
      panic("CI check leg has no identifier");
    }
    expectContinuation(partition.steps, id);
  }
});

test("CI coverage accepts the real local-verification projection", () => {
  const current = actualSteps.find(
    ({ name }) => name === "CLI contract changeset guard",
  );
  const base = baseSteps.find(
    ({ name }) => name === "CLI contract changeset guard",
  );
  if (current === undefined || base === undefined) {
    panic("CLI contract check is missing from CI coverage");
  }
  const step = v.parse(v.record(v.string(), v.unknown()), current);
  const env = v.parse(v.record(v.string(), v.unknown()), step["env"]);
  expect(env["STELLA_VERIFY"]).toBe("check");
  expect(env["CHECK_BASE_REF"]).toBe(LOCAL_CHECK_BASE_REF);
  expect(env["BASE_REF"]).toBe(LOCAL_BASE_REF);
  expect(step["run"]).toBe(`${CLI_CONTRACT_COMMAND} --base "$CHECK_BASE_REF"`);
  expectCoverage({ current: [current], base: [base], removed: [] });
});

test("CI coverage strips only valid local metadata and the exact base-ref handoff", () => {
  const original = {
    name: "CLI contract changeset guard",
    if: "github.event_name == 'pull_request'",
    run: `${CLI_CONTRACT_COMMAND} --base "origin/$BASE_REF"`,
    env: { BASE_REF: LOCAL_BASE_REF, RETAINED: "strict" },
  };
  for (const phase of ["prepare", "check"]) {
    const marked = {
      ...original,
      run: `${CLI_CONTRACT_COMMAND} --base "$CHECK_BASE_REF"`,
      env: {
        ...original.env,
        STELLA_VERIFY: phase,
        CHECK_BASE_REF: LOCAL_CHECK_BASE_REF,
      },
    };
    expectCoverage({ current: [marked], base: [original], removed: [] });
    for (const changed of [
      { ...marked, env: { ...marked.env, STELLA_VERIFY: "later" } },
      { ...marked, env: { ...marked.env, CHECK_BASE_REF: "origin/main" } },
      { ...marked, env: { ...marked.env, BASE_REF: "main" } },
      { ...marked, env: { ...marked.env, RETAINED: "changed" } },
      { ...marked, env: { ...marked.env, UNRELATED: "added" } },
      { ...marked, run: `${marked.run} --skip-check` },
      { ...marked, run: "exit 0" },
      { ...marked, if: "always()" },
      { ...marked, name: "Some other guard" },
    ]) {
      expect(() =>
        expectCoverage({ current: [changed], base: [original], removed: [] }),
      ).toThrow("toEqual");
    }
  }
  for (const phase of ["prepare", "check"]) {
    const step = { name: "Guard", run: "bun check" };
    expectCoverage({
      current: [{ ...step, env: { STELLA_VERIFY: phase } }],
      base: [step],
      removed: [],
    });
    expect(() =>
      expectCoverage({
        current: [{ ...step, env: { STELLA_VERIFY: phase, EXTRA: "value" } }],
        base: [step],
        removed: [],
      }),
    ).toThrow("toEqual");
  }
});

test("CI coverage strips only canonical continuation wrappers and preserves condition, run and inputs", () => {
  for (const CONTINUATION_PREFIX of Object.values(CONTINUATION_PREFIXES)) {
    for (const original of [
      { name: "Guard", run: "bun check" },
      {
        name: "Guard",
        if: "github.event_name == 'pull_request'",
        run: "bun check",
        with: { mode: "strict" },
      },
    ]) {
      const condition =
        "if" in original
          ? `${CONTINUATION_PREFIX} && (${original.if}) }}`
          : `${CONTINUATION_PREFIX} }}`;
      const wrapped = { ...original, if: condition };
      expectCoverage({ current: [wrapped], base: [original], removed: [] });
      for (const modified of [
        { ...wrapped, if: condition.replace("!cancelled()", "always()") },
        {
          ...wrapped,
          if: condition.replace(
            /steps\.(?:checkout\.outcome == 'success'|install\.outcome (?:!= 'failure'|== 'success'))/u,
            "true",
          ),
        },
        { ...wrapped, if: `${CONTINUATION_PREFIX} && (true) }}` },
        { ...wrapped, run: "exit 0" },
        { ...wrapped, with: { mode: "weak" } },
      ]) {
        expect(() =>
          expectCoverage({
            current: [modified],
            base: [original],
            removed: [],
          }),
        ).toThrow("toEqual");
      }
    }
  }
});

test("installation normalization preserves scope and strips only the exact complete safety suffix", () => {
  const original = {
    name: "Install dependencies",
    if: "needs.ci-plan.outputs.package_checks_required == 'true'",
    run: "bun ci --ignore-scripts",
  };
  const condition = `${CONTINUATION_PREFIXES.checkout} && (${original.if})${SAFETY_SUFFIX} }}`;
  expect(withoutContinuation({ ...original, if: condition })).toEqual(original);
  expect(
    withoutContinuation({
      ...original,
      if: condition.replace(
        "steps.standalone_lockfiles.outcome == 'success'",
        "steps.standalone_lockfiles.outcome != 'failure'",
      ),
    }),
  ).not.toEqual(original);
});

test("continuation invariant rejects missing prerequisite gates and masked guard failures", () => {
  const leg = partitions.at(0);
  if (leg === undefined) {
    panic("CI checks have no legs");
  }
  const guard = leg.steps.find(({ name }) => !prerequisites.has(name));
  if (guard === undefined) {
    panic("CI checks have no owned guard");
  }
  for (const changed of [
    { ...guard, if: `\${{ !cancelled() }}` },
    { ...guard, "continue-on-error": true },
  ]) {
    expect(() =>
      expectContinuation(
        leg.steps.map((step) => (step === guard ? changed : step)),
        "ci-checks-generated",
      ),
    ).toThrow(guard.name);
  }
});

test("dependent CI guards require the producing step's successful outcome", () => {
  for (const [name, dependency] of Object.entries(outcomeDependencies)) {
    const base = { name, if: "scope == 'true'", run: "bun check" };
    const CONTINUATION_PREFIX =
      name === "Format"
        ? CONTINUATION_PREFIXES.install
        : CONTINUATION_PREFIXES.checkout;
    const condition = `${CONTINUATION_PREFIX} && (${base.if}) && steps.${dependency}.outcome == 'success' }}`;
    expectCoverage({
      current: [{ ...base, if: condition }],
      base: [base],
      removed: [],
    });
    for (const weakened of [
      `${CONTINUATION_PREFIX} && (${base.if}) }}`,
      condition.replace(`steps.${dependency}.outcome == 'success'`, "true"),
    ]) {
      expect(() =>
        expectCoverage({
          current: [{ ...base, if: weakened }],
          base: [base],
          removed: [],
        }),
      ).toThrow("toEqual");
    }
  }
});

type ConditionContextOptions = {
  outcomes: Record<
    string,
    { outcome: string; outputs?: Record<string, string> }
  >;
  scopes: Record<string, string>;
  event: string;
  cancelled: boolean;
};
const conditionEvaluator = ({
  outcomes,
  scopes,
  event,
  cancelled,
}: ConditionContextOptions) => {
  const context = createContext({
    cancelled: () => cancelled,
    github: { event_name: event },
    steps: outcomes,
    // This oracle proves continuation under full selection; root selection has
    // its own package enumeration and workflow gate census.
    needs: { "ci-plan": { outputs: { ...scopes, root_checks: "" } } },
  });
  return (condition: string) => {
    const expression = condition.startsWith(`\${{`)
      ? condition.slice(4, -3)
      : condition;
    return v.parse(
      v.boolean(),
      runInContext(
        expression.replaceAll("needs.ci-plan", 'needs["ci-plan"]'),
        context,
      ),
    );
  };
};

type SimulateLegOptions = {
  failures: readonly string[];
  lockfileScope: "true" | "false";
};
const simulateRestLeg = ({ failures, lockfileScope }: SimulateLegOptions) => {
  const { steps } = v.parse(headJobSchema, jobs["ci-checks-rest"]);
  const outcomes: Record<
    string,
    { outcome: string; outputs?: Record<string, string> }
  > = {};
  const results: Record<string, string> = {};
  let failed = false;
  const scopes = v.parse(
    v.record(v.string(), v.string()),
    Object.fromEntries(
      steps.flatMap((step) => {
        const condition =
          v.parse(v.looseObject({ if: v.optional(v.string()) }), step).if ?? "";
        return [
          ...condition.matchAll(/needs\.ci-plan\.outputs\.([a-z_]+)/gu),
        ].map((match) => [match.at(1), "true"]);
      }),
    ),
  );
  scopes["lockfile_ages_required"] = lockfileScope;
  for (const step of steps) {
    const { if: condition, id } = v.parse(
      v.looseObject({ if: v.optional(v.string()), id: v.optional(v.string()) }),
      step,
    );
    const enabled =
      condition === undefined
        ? !failed
        : conditionEvaluator({
            outcomes,
            scopes,
            event: "pull_request",
            cancelled: false,
          })(condition);
    let outcome = "skipped";
    if (enabled) {
      outcome = failures.includes(step.name) ? "failure" : "success";
    }
    results[step.name] = outcome;
    if (id !== undefined) {
      outcomes[id] = {
        outcome,
      };
    }
    if (outcome === "failure") {
      failed = true;
    }
  }
  return results;
};

test("an unrelated pre-install failure still runs planned safety, installation and later guards", () => {
  for (const lockfileScope of ["true", "false"] as const) {
    const results = simulateRestLeg({
      failures: ["Changeset packages match changed files"],
      lockfileScope,
    });
    expect(results["Changeset packages match changed files"]).toBe("failure");
    expect(results["Standalone lockfile guard"]).toBe("success");
    expect(results["Lockfile release-age guard"]).toBe(
      lockfileScope === "true" ? "success" : "skipped",
    );
    expect(results["Install dependencies"]).toBe("success");
    expect(results["Check i18n sync"]).toBe("success");
    expect(results["Test remaining repository scripts"]).toBe("success");
  }
});

test("a failed background guard leaves every other planned check runnable", () => {
  const { steps } = v.parse(headJobSchema, jobs["ci-checks-rest"]);
  for (const background of steps.filter(
    (step) => step["background"] === true,
  )) {
    const results = simulateRestLeg({
      failures: [background.name],
      lockfileScope: "true",
    });
    expect(results[background.name]).toBe("failure");
    for (const step of steps) {
      if (step.name === background.name) {
        continue;
      }
      expect(results[step.name], `${background.name} → ${step.name}`).toBe(
        "success",
      );
    }
  }
});

test("a failed planned safety guard prevents installation and every post-install guard", () => {
  for (const guard of preInstallGuards.keys()) {
    const results = simulateRestLeg({
      failures: [guard],
      lockfileScope: "true",
    });
    expect(results[guard]).toBe("failure");
    expect(results["Install dependencies"]).toBe("skipped");
    const { steps } = v.parse(headJobSchema, jobs["ci-checks-rest"]);
    const installIndex = steps.findIndex(
      ({ name }) => name === "Install dependencies",
    );
    for (const step of steps.slice(installIndex + 1)) {
      expect(results[step.name], step.name).toBe("skipped");
    }
  }
});

test("continued guard conditions preserve every previously runnable plan outcome", () => {
  const scopeNames = [
    ...new Set(
      partitions.flatMap(({ steps }) =>
        steps.flatMap((step) => {
          const condition =
            v.parse(v.looseObject({ if: v.optional(v.string()) }), step).if ??
            "";
          return [...condition.matchAll(/needs\.ci-plan\.outputs\.([a-z_]+)/gu)]
            .map((match) => v.parse(v.string(), match.at(1)))
            .filter((name) => name !== "root_checks");
        }),
      ),
    ),
  ];
  // Successful producer outcomes do not imply that their output gates selected
  // every consumer. Derive those decisions from the workflow's conditions.
  const stepOutputs = [
    ...new Set(
      partitions.flatMap(({ steps }) =>
        steps.flatMap((step) => {
          const condition =
            v.parse(v.looseObject({ if: v.optional(v.string()) }), step).if ??
            "";
          return [
            ...condition.matchAll(/steps\.([a-z_]+)\.outputs\.([a-z_]+)/gu),
          ].map(
            (match) =>
              `${v.parse(v.string(), match.at(1))}:${v.parse(v.string(), match.at(2))}`,
          );
        }),
      ),
    ),
  ];
  // Keep the input arbitrary stable so pinned shrink paths remain replayable.
  let outputAssignments: boolean[][] = [[]];
  for (const _reference of stepOutputs) {
    outputAssignments = outputAssignments.flatMap((assignment) => [
      assignment.concat(false),
      assignment.concat(true),
    ]);
  }
  assertProperty(
    "continued guard conditions preserve every previously runnable plan outcome",
    fc.property(
      fc.record({
        event: fc.constantFrom(
          "pull_request",
          "merge_group",
          "workflow_dispatch",
        ),
        scopes: fc.array(fc.boolean(), {
          minLength: scopeNames.length,
          maxLength: scopeNames.length,
        }),
      }),
      (input) => {
        const scopes = v.parse(
          v.record(v.string(), v.string()),
          Object.fromEntries(
            scopeNames.map((name, index) => [
              name,
              input.scopes.at(index) ? "true" : "false",
            ]),
          ),
        );
        for (const outputs of outputAssignments) {
          for (const [index, { steps }] of partitions.entries()) {
            const id = partitionIds.at(index);
            if (id === undefined) {
              panic("CI check leg has no identifier");
            }
            const originals = v.parse(
              headJobSchema,
              baseJobs["ci-checks"] ?? baseJobs[id],
            ).steps;
            const outcomes: ConditionContextOptions["outcomes"] =
              Object.fromEntries(
                steps.flatMap((step) => {
                  const stepId = v.parse(
                    v.looseObject({ id: v.optional(v.string()) }),
                    step,
                  ).id;
                  return stepId === undefined
                    ? []
                    : [
                        [
                          stepId,
                          {
                            outcome: "success",
                            outputs: Object.fromEntries(
                              stepOutputs.flatMap((reference, outputIndex) => {
                                const [producer, output] = reference.split(":");
                                return producer === stepId &&
                                  output !== undefined
                                  ? [
                                      [
                                        output,
                                        outputs.at(outputIndex)
                                          ? "true"
                                          : "false",
                                      ],
                                    ]
                                  : [];
                              }),
                            ),
                          },
                        ],
                      ];
                }),
              );
            outcomes["checkout"] = { outcome: "success" };
            outcomes["install"] = {
              outcome:
                scopes["package_checks_required"] === "true"
                  ? "success"
                  : "skipped",
            };
            const evaluate = conditionEvaluator({
              outcomes,
              scopes,
              event: input.event,
              cancelled: false,
            });
            for (const step of steps) {
              if (prerequisites.has(step.name)) {
                continue;
              }
              const original = originals.find(({ name }) => name === step.name);
              if (original === undefined) {
                continue;
              }
              const originalCondition = v.parse(
                v.looseObject({ if: v.optional(v.string()) }),
                original,
              ).if;
              // Successful plans include intentionally skipped installation;
              // every original runnable guard must survive either plan outcome.
              if (
                originalCondition !== undefined &&
                !evaluate(originalCondition)
              ) {
                continue;
              }
              const condition = v.parse(
                v.looseObject({ if: v.string() }),
                step,
              ).if;
              expect(evaluate(condition), `${id}: ${step.name}`).toBe(true);
            }
            const checkoutIndex = steps.findIndex(
              ({ name }) => name === "Checkout",
            );
            expect(checkoutIndex).toBeGreaterThanOrEqual(0);
            for (const checkoutOutcome of ["failure", "skipped"]) {
              const unavailableOutcomes = Object.fromEntries(
                Object.keys(outcomes).map((stepId) => [
                  stepId,
                  { outcome: "skipped" },
                ]),
              );
              unavailableOutcomes["checkout"] = { outcome: checkoutOutcome };
              const evaluateUnavailable = conditionEvaluator({
                outcomes: unavailableOutcomes,
                scopes,
                event: input.event,
                cancelled: false,
              });
              for (const step of steps.slice(checkoutIndex + 1)) {
                const condition = v.parse(
                  v.looseObject({ if: v.string() }),
                  step,
                ).if;
                expect(
                  evaluateUnavailable(condition),
                  `${id}: checkout ${checkoutOutcome}: ${step.name}`,
                ).toBe(false);
              }
            }
            if (id !== "ci-checks-rest") {
              continue;
            }
            const installIndex = steps.findIndex(
              ({ name }) => name === "Install dependencies",
            );
            outcomes["install"] = { outcome: "skipped" };
            for (const guard of preInstallGuards.keys()) {
              const guardId = stepIds[guard];
              if (guardId === undefined) {
                panic("Safety guard has no outcome identifier");
              }
              outcomes[guardId] = { outcome: "failure" };
              for (const step of steps.slice(installIndex + 1)) {
                const condition = v.parse(
                  v.looseObject({ if: v.string() }),
                  step,
                ).if;
                expect(evaluate(condition), `${guard}: ${step.name}`).toBe(
                  false,
                );
              }
              outcomes[guardId] = { outcome: "success" };
            }
          }
        }
      },
    ),
    { numRuns: 32 },
  );
});

test("setup migration preserves runtime inputs and protected install policy", () => {
  const setup = {
    name: "Setup Bun",
    uses: "oven-sh/setup-bun@<pinned>",
    with: { "bun-version-file": "package.json" },
  };
  const install = {
    name: "Install dependencies",
    uses: "$/.github/actions/ci-install",
    with: { flags: ownedInstallFlags },
  };
  const job = { steps: [setup, install] };
  const migrated = withInstallCache(setup, job);
  expect(migrated).toEqual({
    ...setup,
    uses: "stella/.github/actions/setup-bun-cached@<pinned>",
    with: { ...setup.with, save: `\${{ github.ref == 'refs/heads/main' }}` },
  });
  expect(withInstallCache(install, job)).toEqual({
    name: "Install dependencies",
    run: "bash scripts/retry.sh bun ci --ignore-scripts",
  });
  const guardedInstall = {
    ...install,
    id: "install",
    if: "needs.ci-plan.outputs.package_checks_required == 'true'",
    env: { NPM_TOKEN: "" },
  };
  expect(withInstallCache(guardedInstall, job)).toEqual({
    name: "Install dependencies",
    id: "install",
    if: "needs.ci-plan.outputs.package_checks_required == 'true'",
    env: { NPM_TOKEN: "" },
    run: "bash scripts/retry.sh bun ci --ignore-scripts",
  });
  const derivedTimeoutJob = { ...job, "runs-on": "ubuntu-latest" };
  const derivedTimeoutInstall = {
    ...guardedInstall,
    "timeout-minutes": 3,
  };
  expect(withInstallCache(derivedTimeoutInstall, derivedTimeoutJob)).toEqual({
    name: "Install dependencies",
    id: "install",
    if: "needs.ci-plan.outputs.package_checks_required == 'true'",
    env: { NPM_TOKEN: "" },
    run: "bash scripts/retry.sh bun ci --ignore-scripts",
  });
  const unapprovedTimeout = { ...derivedTimeoutInstall, "timeout-minutes": 4 };
  expect(withInstallCache(unapprovedTimeout, derivedTimeoutJob)).toEqual({
    name: "Install dependencies",
    id: "install",
    if: "needs.ci-plan.outputs.package_checks_required == 'true'",
    env: { NPM_TOKEN: "" },
    "timeout-minutes": 4,
    run: "bash scripts/retry.sh bun ci --ignore-scripts",
  });
  for (const flags of [
    '["--ignore-scripts"]',
    '["--frozen-lockfile","--ignore-scripts","--filter","other"]',
  ]) {
    const changedInstall = { ...install, with: { flags } };
    const changed = { ...job, steps: [setup, changedInstall] };
    expect(withInstallCache(setup, changed)).toEqual(setup);
    expect(withInstallCache(changedInstall, changed)).toEqual(changedInstall);
  }
  const nonScoped = {
    ...job,
    steps: [
      setup,
      { name: "Install dependencies", run: "bun ci --ignore-scripts" },
    ],
  };
  expect(withInstallCache(setup, nonScoped)).toEqual(setup);
  const noCache = { ...setup, with: { ...setup.with, "no-cache": true } };
  for (const steps of [
    [noCache, install],
    [
      { name: "Install Safe Chain", uses: "./.github/actions/safe-chain" },
      setup,
      install,
    ],
  ]) {
    expect(withInstallCache(setup, { steps })).toEqual(setup);
  }
  const mutable = { ...setup, uses: "oven-sh/setup-bun@main" };
  expect(withInstallCache(mutable, { steps: [mutable, install] })).toEqual(
    mutable,
  );
});

test("documentation policy widens only its package gate and retains successful installation", () => {
  const policy = partitions[partitionIds.indexOf("ci-checks-policy")];
  if (!policy) {
    panic("Missing policy leg");
  }
  for (const name of DOCUMENTATION_CHECKS) {
    const step = policy.steps.find((entry) => entry.name === name);
    expect(step?.["if"]).toBe(`${CONTINUATION_PREFIXES.installPackages} }}`);
    expect(step?.["run"]).toBeTruthy();
    const base = {
      name,
      run: "bun guard.ts",
      if: `${CONTINUATION_PREFIXES.installPackages} && (${PACKAGE_SCOPE}) }}`,
    };
    expect(documentationScope(base)).toEqual({
      ...base,
      if: `${CONTINUATION_PREFIXES.installPackages} }}`,
    });
    const unrelated = { ...base, name: "Unrelated guard" };
    expect(documentationScope(unrelated)).toEqual(unrelated);
  }
});

const expectCancellationNormalization = (
  schema: ReturnType<typeof cancellationJobSchema>,
  candidateJobs: Record<string, unknown>,
  // Pooled checks come from the same tree as the jobs under test.
  readPool: ReadCheckPool,
) => {
  for (const id of partitionIds) {
    const original = v.parse(
      v.looseObject({ steps: v.unknown() }),
      candidateJobs[id],
    );
    const leaves = flattenWorkflowSteps(original.steps, readPool).filter(
      (step) => !isWorkflowBarrier(step),
    );
    const normalized = v.parse(schema, original);
    // The wider leaves are the subject of Bun’s typed equality matcher.
    expect(leaves.slice(0, -1)).toEqual(normalized.steps);
    const tail = leaves.at(-1);
    if (!tail) {
      panic("Workflow cancellation tail unavailable");
    }
    const mutated = structuredClone(original);
    const changedTail = flattenWorkflowSteps(mutated.steps, readPool).findLast(
      (step) => !isWorkflowBarrier(step),
    );
    if (!changedTail) {
      panic("Cloned workflow cancellation tail unavailable");
    }
    changedTail["continue-on-error"] = true;
    expect([
      ...leaves.slice(0, -1),
      { ...tail, "continue-on-error": true },
    ]).toEqual(v.parse(schema, mutated).steps);
  }
};

test("baseline cancellation normalization uses its own owner and rejects changed tails", () => {
  expectCancellationNormalization(
    baseCancellationSchema,
    baseJobs,
    readBaseCheckPool,
  );
});

test("head cancellation normalization is valid as the next base and rejects changed tails", () => {
  expectCancellationNormalization(
    headCancellationSchema,
    jobs,
    readWorkingTreeCheckPool,
  );
});

test("already hydrated merge-base jobs retain their generated manifest environment", () => {
  const base = {
    if: "scope",
    needs: "ci-plan",
    env: {
      CI_GENERATED_SOURCES_MANIFEST: `\${{ github.workspace }}/.cache/ci-generated-sources/manifest.json`,
    },
  };
  expectScope({ current: base, base });
  const { env: _env, ...missing } = base;
  expect(() => expectScope({ current: missing, base })).toThrow("toEqual");
});

test("a merge base with a separate producer job maps to the plan that now produces", () => {
  const current = {
    if: "scope",
    needs: "ci-plan",
    env: {
      CI_GENERATED_SOURCES_MANIFEST: `\${{ github.workspace }}/.cache/ci-generated-sources/manifest.json`,
    },
  };
  const base = { ...current, needs: ["ci-plan", "ci-generated-sources"] };
  expectScope({ current, base });
  const { env: _env, ...missing } = current;
  for (const changed of [
    missing,
    { ...current, needs: ["ci-plan", "unrelated"] },
    { ...current, needs: ["ci-plan", "ci-generated-sources"] },
  ]) {
    expect(() => expectScope({ current: changed, base })).toThrow("toEqual");
  }
});
