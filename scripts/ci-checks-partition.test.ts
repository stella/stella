import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

const jobSchema = v.looseObject({
  steps: v.array(v.looseObject({ name: v.string() })),
});
const workflowSchema = v.object({ jobs: v.record(v.string(), v.unknown()) });
const jobs = v.parse(
  workflowSchema,
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  ),
).jobs;
const original = v.parse(
  v.object({ "ci-checks": jobSchema }),
  Bun.YAML.parse(
    readFileSync(
      new URL("fixtures/ci-checks-unsplit.yml", import.meta.url),
      "utf-8",
    ),
  ),
)["ci-checks"];

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

type Step = v.InferOutput<typeof jobSchema>["steps"][number];

const ownedSteps = (steps: readonly Step[]) =>
  steps
    .filter(({ name }) => !prerequisites.has(name))
    .toSorted((left, right) => left.name.localeCompare(right.name));

const actualSteps = partitions.flatMap(({ steps }) => steps);

test("parallel CI checks preserve every original check exactly once", () => {
  expect(ownedSteps(actualSteps)).toEqual(ownedSteps(original.steps));
});

test("each CI check leg preserves setup, supply-chain protection and job scope", () => {
  const { steps: originalSteps, ...originalScope } = original;
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
});

test("CI check coverage detects missing, duplicate, modified and newly required steps", () => {
  const owned = ownedSteps(original.steps);
  const step = owned.at(0);
  expect(step).toBeDefined();
  if (!step) {
    return;
  }

  expect(
    ownedSteps(actualSteps.filter(({ name }) => name !== step.name)),
  ).not.toEqual(owned);
  expect(ownedSteps([...actualSteps, step])).not.toEqual(owned);
  expect(
    ownedSteps(
      actualSteps.map((current) =>
        current.name === step.name ? { ...current, run: "exit 0" } : current,
      ),
    ),
  ).not.toEqual(owned);
  expect(ownedSteps(actualSteps)).not.toEqual(
    ownedSteps([
      ...original.steps,
      { name: "Additional required guard", run: "exit 1" },
    ]),
  );
});

test("unrelated jobs may use unnamed steps or reusable workflows", () => {
  const parsed = v.parse(workflowSchema, {
    jobs: {
      unrelated: { steps: [{ run: "exit 0" }] },
      reusable: { uses: "./.github/workflows/other.yml" },
      checks: original,
    },
  });
  expect(v.parse(jobSchema, parsed.jobs["checks"])).toEqual(original);
});
