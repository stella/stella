import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { CUSTOM_LINT_TEST_ARGS } from "./check-oxlint-rule-coverage.ts";

const jobSchema = v.looseObject({
  steps: v.array(v.looseObject({ name: v.string() })),
});
const workflowSchema = v.object({ jobs: v.record(v.string(), v.unknown()) });
const removalSchema = v.array(
  v.object({ name: v.string(), reason: v.pipe(v.string(), v.minLength(1)) }),
);
const workflowPath = ".github/workflows/ci.yml";
const removalsPath = "scripts/ci-checks-removed.json";
const repository = new URL("../", import.meta.url).pathname;
const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: repository });
  if (result.exitCode !== 0) {
    panic(`CI check baseline unavailable: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};
const mergeBase = git(["merge-base", "origin/main", "HEAD"]);
const parseJobs = (source: string) =>
  v.parse(workflowSchema, Bun.YAML.parse(source)).jobs;
const jobs = parseJobs(
  readFileSync(new URL(`../${workflowPath}`, import.meta.url), "utf-8"),
);
const baseJobs = parseJobs(git(["show", `${mergeBase}:${workflowPath}`]));
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
const prerequisites = new Set([
  "Checkout",
  "Setup Bun",
  "Turbo remote cache",
  "Install dependencies",
  "Prepare environment",
]);
const partitions = partitionIds.map((id) => v.parse(jobSchema, jobs[id]));
const readBaseline = (source: v.InferOutput<typeof workflowSchema>["jobs"]) => {
  if (source["ci-checks"] !== undefined) {
    for (const id of partitionIds) {
      expect(source).not.toHaveProperty(id);
    }
    return [v.parse(jobSchema, source["ci-checks"])];
  }
  return partitionIds.map((id) => v.parse(jobSchema, source[id]));
};
const baseline = readBaseline(baseJobs);

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
const setupSteps = (steps: readonly Step[]) =>
  steps.filter(({ name }) => prerequisites.has(name)).map(withoutActionRef);
const ownedSteps = (steps: readonly Step[]) =>
  steps
    .filter(({ name }) => !prerequisites.has(name))
    .map(withoutActionRef)
    .toSorted((left, right) => left.name.localeCompare(right.name));

// YAML folding changes whitespace outside literals, not the condition's tokens.
const conditionTokens = (condition: string) =>
  condition
    .replaceAll(/'(?:[^']|'')*'|\s+/gu, (token) =>
      token.startsWith("'") ? token : " ",
    )
    .trim();
type ScopeOptions = {
  current: Record<string, unknown>;
  base: Record<string, unknown>;
};
const expectScope = ({ current, base }: ScopeOptions) => {
  const { if: condition, ...scope } = current;
  const { if: originalCondition, ...originalScope } = base;
  expect(scope).toEqual(originalScope);
  if (condition === originalCondition) {
    return;
  }
  // Heavy-only main runs skip the thin ci-checks legs. Only this wrapper
  // may change their scope; every token of the base condition stays intact.
  const wrapped = /^inputs\.heavy_only != true && \(\s*(.*?)\s*\)$/u.exec(
    conditionTokens(v.parse(v.string(), condition)),
  );
  expect(wrapped?.at(1)).toBe(
    conditionTokens(v.parse(v.string(), originalCondition)),
  );
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
const baseSteps = legSteps(baseline, baselineIds);
for (const step of baseSteps) {
  if (
    step.name !== "Documentation source policy rule" ||
    step["run"] !== `${lintFixtureCommand}\nbun run check:docs-sources\n`
  ) {
    continue;
  }
  // The coverage owner now runs these fixtures and records their outcomes.
  const coverage = actualSteps.find(
    ({ name }) => name === "Custom lint rule coverage",
  );
  expect(coverage?.["if"]).toBe(step["if"]);
  expect(coverage?.["run"]).toBe(
    "bun test scripts/check-oxlint-rule-coverage.test.ts\nbun scripts/check-oxlint-rule-coverage.ts\n",
  );
  expect(coverage?.["env"]).toEqual({
    BASE_SHA: `\${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || '' }}`,
  });
  step["run"] = "bun run check:docs-sources";
}

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
    const originalSetup = setupSteps(originalSteps);
    expect(originalSetup).toHaveLength(prerequisites.size);
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
    prerequisites.has(name),
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
    current: split.flatMap(({ steps }) => steps),
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
