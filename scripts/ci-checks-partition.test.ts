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
import { CUSTOM_LINT_TEST_ARGS } from "./check-oxlint-rule-coverage.ts";
import { CANONICAL_CANCEL_STEP } from "./ci-cancellation-contract";
import { jobCachePolicy } from "./workflow-cache-policy.ts";
import { flattenWorkflowSteps, isWorkflowBarrier } from "./workflow-steps";

const cancellationJobSchema = (canonical: object) =>
  v.pipe(
    v.looseObject({
      permissions: v.optional(v.record(v.string(), v.string())),
      steps: v.pipe(
        v.unknown(),
        v.transform((steps) =>
          flattenWorkflowSteps(steps).filter(
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
const jobSchema = cancellationJobSchema(CANONICAL_CANCEL_STEP);
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
          v.transform(flattenWorkflowSteps),
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
const mergeBase = git(["merge-base", "origin/main", "HEAD"]);
const baseCancellationSource = new Bun.Transpiler({
  loader: "ts",
}).transformSync(
  git(["show", `${mergeBase}:scripts/ci-cancellation-contract.ts`]),
);
const baseCancellation = v.parse(
  v.object({ CANONICAL_CANCEL_STEP: v.record(v.string(), v.unknown()) }),
  await import(
    `data:text/javascript;base64,${Buffer.from(baseCancellationSource).toString("base64")}`
  ),
).CANONICAL_CANCEL_STEP;
const baseJobSchema = cancellationJobSchema(baseCancellation);
const parseJobs = (source: string) =>
  v.parse(workflowSchema, Bun.YAML.parse(source)).jobs;
const jobs = parseJobs(
  readFileSync(new URL(`../${workflowPath}`, import.meta.url), "utf-8"),
);
const baseWorkflow: unknown = Bun.YAML.parse(
  git(["show", `${mergeBase}:${workflowPath}`]),
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
const partitions = partitionIds.map((id) => v.parse(jobSchema, jobs[id]));
const readBaseline = (
  source: v.InferOutput<typeof workflowSchema>["jobs"],
  schema = jobSchema,
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

type Step = v.InferOutput<typeof jobSchema>["steps"][number];
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
  checkout: "${{ !cancelled() && steps.checkout.outcome == 'success'",
  install:
    "${{ !cancelled() && steps.checkout.outcome == 'success' && steps.install.outcome != 'failure' && steps.standalone_lockfiles.outcome != 'failure' && steps.lockfile_ages.outcome != 'failure'",
  installPackages: "${{ !cancelled() && steps.install.outcome == 'success'",
} as const;
const outcomeDependencies: Record<string, string> = {
  Format: "affected",
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
const withoutContinuation = (step: Step): Step => {
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
// Shared runners need ephemeral cache ports. Preserve every other baseline input.
const withIsolatedCachePort = (step: Step): Step => {
  if (usesOf(step) !== "rharkor/caching-for-turbo@<pinned>") {
    return step;
  }
  const inputs = v.parse(
    v.looseObject({ with: v.optional(v.record(v.string(), v.unknown())) }),
    step,
  ).with;
  return { ...step, with: { ...inputs, "server-port": "0" } };
};
// Only ordinary install jobs may migrate to the shared dependency cache owner.
const withInstallCache = (step: Step, job: Record<string, unknown>): Step => {
  if (
    jobCachePolicy({ workflow: baseWorkflow, job }) !== "install-cache" ||
    usesOf(step) !== "oven-sh/setup-bun@<pinned>"
  ) {
    return step;
  }
  const inputs = v.parse(
    v.looseObject({ with: v.optional(v.record(v.string(), v.unknown())) }),
    step,
  ).with;
  return {
    ...step,
    uses: "stella/.github/actions/setup-bun-cached@<pinned>",
    with: { ...inputs, save: `\${{ github.ref == 'refs/heads/main' }}` },
  };
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
  "Instruction references",
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

const ownedSteps = (steps: readonly Step[]) =>
  steps
    .filter(({ name }) => !prerequisites.has(name))
    .map(documentationScope)
    .map(withoutContinuation)
    .map(withoutPreparedGeneration)
    .map(withoutTestTimeout)
    .map(withoutStepId)
    .map((step) => {
      const { background, ...check } = step;
      if (background !== true) {
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
type ScopeOptions = {
  current: Record<string, unknown>;
  base: Record<string, unknown>;
};
const expectScope = ({ current, base }: ScopeOptions) => {
  const { if: condition, ...scope } = current;
  const { if: originalCondition, ...originalScope } = base;
  const originalEnvironment =
    originalScope["env"] === undefined
      ? undefined
      : v.parse(v.record(v.string(), v.unknown()), originalScope["env"]);
  const hydrationDependency =
    originalScope["needs"] === "ci-plan" &&
    isDeepStrictEqual(scope["needs"], ["ci-plan", "ci-generated-sources"]) &&
    !Object.hasOwn(
      originalEnvironment ?? {},
      "CI_GENERATED_SOURCES_MANIFEST",
    ) &&
    isDeepStrictEqual(scope["env"], {
      ...originalEnvironment,
      CI_GENERATED_SOURCES_MANIFEST: `\${{ github.workspace }}/.cache/ci-generated-sources/manifest.json`,
    });
  const migrated = { ...scope };
  // Normalize only an added handoff. A baseline that owns it must retain it.
  if (hydrationDependency) {
    migrated["needs"] = "ci-plan";
    if (originalEnvironment === undefined) {
      delete migrated["env"];
    } else {
      migrated["env"] = originalEnvironment;
    }
  }
  expect(migrated).toEqual(originalScope);
  // Ordinary scope comparisons supply fresh-run evidence. Completion reuse
  // is exercised separately by the depth contract's true/false census. A
  // merge base may already carry the completion guard, so strip it from both.
  const freshScope = (value: unknown) => {
    const tokens = conditionTokens(v.parse(v.string(), value));
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
const legSteps = (
  legs: readonly v.InferOutput<typeof jobSchema>[],
  ids: readonly string[],
) =>
  legs.flatMap(({ steps }, index) => {
    const id = ids.at(index);
    if (!id) {
      panic("CI check leg has no identifier");
    }
    return steps.map((step) =>
      step.name === "Install Safe Chain"
        ? { ...step, name: `${id}: ${step.name}` }
        : step,
    );
  });
const actualSteps = legSteps(partitions, partitionIds);
const lintFixtureCommand = ["bun", ...CUSTOM_LINT_TEST_ARGS].join(" ");
const stepFieldsSchema = v.looseObject({
  env: v.optional(v.unknown()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
});
const stepFields = (step: Step | undefined) =>
  v.parse(stepFieldsSchema, step ?? {});
const baseSteps = legSteps(baseline, baselineIds).map((step) => {
  const fields = stepFields(step);
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
    BASE_SHA: `\${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || '' }}`,
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
  expect(v.parse(jobSchema, job)).toEqual(base);
  for (const changed of [
    { ...cancellation, if: "failure()" },
    { ...cancellation, uses: "actions/github-script@main" },
    { ...cancellation, with: { ...cancellation.with, retries: 1 } },
    { ...cancellation, with: { ...cancellation.with, script: "exit 0" } },
    { ...cancellation, "continue-on-error": true },
  ]) {
    expect(v.parse(jobSchema, { ...job, steps: [guard, changed] })).not.toEqual(
      base,
    );
  }
  expect(
    v.parse(jobSchema, { ...job, steps: [cancellation, guard] }),
  ).not.toEqual(base);
  expect(() =>
    v.parse(jobSchema, {
      ...job,
      permissions: { contents: "read", actions: "read" },
    }),
  ).toThrow("toBe");
  expect(
    v.parse(jobSchema, {
      ...job,
      permissions: { ...job.permissions, contents: "write" },
    }),
  ).not.toEqual(base);
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
      .map(withIsolatedCachePort)
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
      const reordered = new Set(
        steps
          .filter((step) => step["background"] === true)
          .map(({ name }) => name),
      );
      if (partitionIds.at(index) === "ci-checks-rest") {
        reordered.add("Prepare environment");
        reordered.add("Content delivery declarations");
        reordered.add("Test release image CI gate");
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
    expectScope({ current: scope, base: originalScope });
    expect(timeout).toBe(
      partitionIds.at(index) === "ci-checks-generated" ? 60 : originalTimeout,
    );
    expect(setupSteps(steps)).toEqual(originalSetup);
    const installIndex = steps.findIndex(
      ({ name }) => name === "Install dependencies",
    );
    expect(steps.findIndex(({ name }) => name === "Setup Bun")).toBeLessThan(
      installIndex,
    );
    expect(steps.at(installIndex)?.["run"]).toBe(
      "bash scripts/retry.sh bun ci --ignore-scripts",
    );
  }
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
      needs: ["ci-plan", "ci-generated-sources"],
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
    { ...wrapped, needs: ["ci-plan", "ci-generated-sources", "unrelated"] },
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
      needs: ["ci-plan", "ci-generated-sources"],
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
      needs: ["ci-plan", "ci-generated-sources"],
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
      { ...handoff, env: environment },
      { ...handoff, needs: "ci-plan" },
      { ...handoff, needs: ["ci-generated-sources", "ci-plan"] },
      { ...handoff, needs: ["ci-plan", "ci-generated-sources", "unrelated"] },
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
    needs: ["ci-plan", "ci-generated-sources"],
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
  const serial = v.parse(jobSchema, { steps: [step] });
  const concurrent = v.parse(jobSchema, {
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
      v.parse(jobSchema, {
        steps: [{ parallel: [{ ...step, run: "exit 0" }] }],
      }).steps,
    ),
  ).not.toEqual(ownedSteps(serial.steps));
});

test("repository backgrounds are bounded and joined before failure cancellation", () => {
  const raw = v.parse(v.object({ steps: v.unknown() }), jobs["ci-checks-rest"]);
  const steps = flattenWorkflowSteps(raw.steps);
  const firstBackground = steps.findIndex(
    (step) => step["background"] === true,
  );
  expect(firstBackground).toBeGreaterThan(0);
  for (const name of [
    "Checkout",
    "Setup Bun",
    "Install dependencies",
    "Download generated sources",
    "Restore generated sources",
    "Prepare route network manifest",
    "Restore route network baseline",
    "Prepare environment",
    "Content delivery declarations",
  ]) {
    const index = steps.findIndex((step) => step["name"] === name);
    expect(index, name).toBeGreaterThanOrEqual(0);
    expect(index, name).toBeLessThan(firstBackground);
    expect(steps.at(index)?.["background"], name).toBeUndefined();
  }
  const pending = new Set<string>();
  let launched = 0;
  for (const step of steps) {
    if (step["background"] === true) {
      const id = v.parse(v.string(), step["id"]);
      expect(pending.has(id), id).toBe(false);
      pending.add(id);
      launched++;
      expect(pending.size).toBeLessThanOrEqual(2);
      expect(step["continue-on-error"]).toBeUndefined();
      continue;
    }
    if (isWorkflowBarrier(step)) {
      expect(pending.size).toBeGreaterThan(0);
      expect(step["if"]).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
      if ("wait" in step) {
        const ids = v.parse(v.array(v.string()), step["wait"]);
        for (const id of ids) {
          expect(pending.delete(id), id).toBe(true);
        }
      } else {
        expect(Object.keys(step).toSorted()).toEqual(["name", "wait-all"]);
        pending.clear();
      }
      continue;
    }
    if (step["name"] === "Cancel failed merge-group run") {
      expect(pending.size).toBe(0);
    }
  }
  expect(launched).toBe(6);
  expect(pending.size).toBe(0);
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
        : [step],
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
    expect(continueOnError, step.name).toBeUndefined();
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
  outcomes: Record<string, { outcome: string }>;
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
    needs: { "ci-plan": { outputs: scopes } },
  });
  return (condition: string) => {
    const expression = condition.startsWith("${{")
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
  const { steps } = v.parse(jobSchema, jobs["ci-checks-rest"]);
  const outcomes: Record<string, { outcome: string }> = {};
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
      outcomes[id] = { outcome };
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
  const { steps } = v.parse(jobSchema, jobs["ci-checks-rest"]);
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
    const { steps } = v.parse(jobSchema, jobs["ci-checks-rest"]);
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
          return [
            ...condition.matchAll(/needs\.ci-plan\.outputs\.([a-z_]+)/gu),
          ].map((match) => v.parse(v.string(), match.at(1)));
        }),
      ),
    ),
  ];
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
        for (const [index, { steps }] of partitions.entries()) {
          const id = partitionIds.at(index);
          if (id === undefined) {
            panic("CI check leg has no identifier");
          }
          const originals = v.parse(
            jobSchema,
            baseJobs["ci-checks"] ?? baseJobs[id],
          ).steps;
          const outcomes = Object.fromEntries(
            steps.flatMap((step) => {
              const stepId = v.parse(
                v.looseObject({ id: v.optional(v.string()) }),
                step,
              ).id;
              return stepId === undefined
                ? []
                : [[stepId, { outcome: "success" }]];
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
              expect(evaluate(condition), `${guard}: ${step.name}`).toBe(false);
            }
            outcomes[guardId] = { outcome: "success" };
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
  const migrated = withInstallCache(setup, { steps: [setup] });
  expect(migrated).toEqual({
    ...setup,
    uses: "stella/.github/actions/setup-bun-cached@<pinned>",
    with: { ...setup.with, save: `\${{ github.ref == 'refs/heads/main' }}` },
  });
  const noCache = { ...setup, with: { ...setup.with, "no-cache": true } };
  for (const steps of [
    [noCache],
    [{ uses: "./.github/actions/safe-chain" }, setup],
  ]) {
    expect(withInstallCache(setup, { steps })).toEqual(setup);
  }
  const mutable = { ...setup, uses: "oven-sh/setup-bun@main" };
  expect(withInstallCache(mutable, { steps: [mutable] })).toEqual(mutable);
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

test("baseline cancellation normalization uses its own owner and rejects changed tails", () => {
  for (const id of partitionIds) {
    const raw = v.parse(
      v.looseObject({ steps: v.array(v.looseObject({ name: v.string() })) }),
      baseJobs[id],
    );
    const normalized = v.parse(baseJobSchema, baseJobs[id]);
    const leaves = flattenWorkflowSteps(raw.steps).filter(
      (step) => !isWorkflowBarrier(step),
    );
    // The leaves are the wider type, so they are the subject of the match.
    expect(leaves.slice(0, -1)).toEqual(normalized.steps);
    const tail = leaves.at(-1);
    if (!tail) {
      panic("Baseline cancellation tail unavailable");
    }
    const original = v.parse(v.record(v.string(), v.unknown()), baseJobs[id]);
    const mutated = {
      ...original,
      steps: [
        ...raw.steps.slice(0, -1),
        { ...tail, "continue-on-error": true },
      ],
    };
    expect([
      ...leaves.slice(0, -1),
      { ...tail, "continue-on-error": true },
    ]).toEqual(v.parse(baseJobSchema, mutated).steps);
  }
});

test("already hydrated merge-base jobs retain their generated manifest environment", () => {
  const base = {
    if: "scope",
    needs: ["ci-plan", "ci-generated-sources"],
    env: {
      CI_GENERATED_SOURCES_MANIFEST: `\${{ github.workspace }}/.cache/ci-generated-sources/manifest.json`,
    },
  };
  expectScope({ current: base, base });
  const { env: _env, ...missing } = base;
  expect(() => expectScope({ current: missing, base })).toThrow("toEqual");
});
