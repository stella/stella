import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

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
  "Install Safe Chain",
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
const ownedSteps = (steps: readonly Step[]) =>
  steps
    .filter(({ name }) => !prerequisites.has(name))
    .toSorted((left, right) => left.name.localeCompare(right.name));

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
  expect(actual).toEqual(
    expected.filter(({ name }) => !removedNames.has(name)),
  );
};
const actualSteps = partitions.flatMap(({ steps }) => steps);
const baseSteps = baseline.flatMap(({ steps }) => steps);

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
  for (const base of baseline) {
    const { steps: originalSteps, ...originalScope } = base;
    const originalSetup = originalSteps.filter(({ name }) =>
      prerequisites.has(name),
    );
    expect(originalSetup).toHaveLength(prerequisites.size);
    for (const { steps, ...scope } of partitions) {
      expect(scope).toEqual(originalScope);
      expect(steps.filter(({ name }) => prerequisites.has(name))).toEqual(
        originalSetup,
      );
      const installIndex = steps.findIndex(
        ({ name }) => name === "Install dependencies",
      );
      expect(steps.findIndex(({ name }) => name === "Setup Bun")).toBeLessThan(
        installIndex,
      );
      expect(
        steps.findIndex(({ name }) => name === "Install Safe Chain"),
      ).toBeLessThan(installIndex);
    }
  }
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
