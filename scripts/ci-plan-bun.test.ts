import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { evaluate, type Context } from "./github-expression";
import { flattenWorkflowSteps } from "./workflow-steps";

const configured = v.parse(
  v.object({
    on: v.record(v.string(), v.unknown()),
    jobs: v.object({
      "ci-plan": v.object({
        if: v.string(),
        steps: v.pipe(
          v.unknown(),
          v.transform(flattenWorkflowSteps),
          v.array(
            v.object({
              id: v.optional(v.string()),
              name: v.string(),
              if: v.optional(v.string()),
              uses: v.optional(v.string()),
              run: v.optional(v.string()),
            }),
          ),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const plan = configured.jobs["ci-plan"];

const assertBunSetupContract = (candidate: typeof plan, context: Context) => {
  const values = { ...context.values };
  const enabled = (condition = "true") => {
    const result = evaluate(condition, { ...context, values });
    expect(typeof result, `Unresolved condition: ${condition}`).toBe("boolean");
    return result === true;
  };
  let setups = 0;
  let consumers = 0;
  if (!enabled(candidate.if)) {
    return { setups, consumers };
  }
  for (const step of candidate.steps) {
    const runs = enabled(step.if);
    if (
      runs &&
      step.uses?.startsWith("stella/.github/actions/setup-bun-cached@")
    ) {
      setups++;
    }
    if (runs && /\bbun\b/u.test(step.run ?? "")) {
      consumers++;
      expect(setups, `Bun setup count before ${step.name}`).toBe(1);
    }
    if (step.id) {
      values[`steps.${step.id}.outcome`] = runs ? "success" : "skipped";
    }
  }
  expect(setups, "Bun setup count at job completion").toBe(
    consumers > 0 ? 1 : 0,
  );
  return { setups, consumers };
};

// Reusable workflows retain their caller's event: main heavy calls can originate
// from push, schedule or dispatch, rather than reporting workflow_call.
const callerEvents = Object.keys(
  v.parse(
    v.object({ on: v.record(v.string(), v.unknown()) }),
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/main-heavy.yml", import.meta.url),
        "utf-8",
      ),
    ),
  ).on,
);
const events = [
  ...new Set([
    ...Object.keys(configured.on).filter((event) => event !== "workflow_call"),
    ...callerEvents,
  ]),
];

const axes = [
  ["github.event_name", events],
  ["inputs.heavy_only", [false, true]],
  ["steps.depth.outputs.suite_depth", ["fast", "full"]],
  ["steps.depth.outputs.queue_depth", ["", "full", "thin"]],
  ["steps.check.outputs.trusted", ["", "false", "true"]],
  ["steps.completed-depth.outputs.run_required", ["", "false", "true"]],
  ["github.event.pull_request.draft", [false, true]],
  ["github.event.pull_request.head.repo.fork", [false, true]],
  ["github.token", ["", "fixture-token"]],
  ["steps.pilot.outputs.coverage_profile", ["normal-v1", "pilot-fast-v1"]],
  ["steps.changed-files.outputs.package_checks_required", ["false", "true"]],
  ["steps.changed-files.outputs.api_scope_unknown", ["false", "true"]],
] as const satisfies readonly (readonly [
  string,
  readonly (string | boolean)[],
])[];

let combinations: Context["values"][] = [{}];
for (const [name, options] of axes) {
  combinations = combinations.flatMap((values) =>
    options.map((value) => ({ ...values, [name]: value })),
  );
}
const contexts = combinations
  .filter((values) => {
    const event = values["github.event_name"];
    const heavyOnly = values["inputs.heavy_only"];
    const suiteDepth = values["steps.depth.outputs.suite_depth"];
    const queueDepth = values["steps.depth.outputs.queue_depth"];
    if ((event === "push" || event === "schedule") && !heavyOnly) {
      return false;
    }
    if ((heavyOnly || event === "merge_group") && suiteDepth !== "full") {
      return false;
    }
    if (!heavyOnly && event === "pull_request" && suiteDepth !== "fast") {
      return false;
    }
    if ((event !== "merge_group" || heavyOnly) && queueDepth !== "") {
      return false;
    }
    if (event !== "pull_request" && values["github.event.pull_request.draft"]) {
      return false;
    }
    if (
      values["github.event.pull_request.head.repo.fork"] &&
      (event !== "pull_request" ||
        values["steps.check.outputs.trusted"] === "true")
    ) {
      return false;
    }
    if (
      values["steps.pilot.outputs.coverage_profile"] === "pilot-fast-v1" &&
      (event !== "pull_request" ||
        values["steps.check.outputs.trusted"] !== "true")
    ) {
      return false;
    }
    return true;
  })
  .map(
    (values) =>
      ({
        values,
        status: { success: true, failure: false, cancelled: false },
      }) satisfies Context,
  );

test("ci-plan sets up Bun exactly once before every Bun consumer across event, depth and trust branches", () => {
  let consumingPaths = 0;
  let skippedPaths = 0;
  for (const context of contexts) {
    const { consumers } = assertBunSetupContract(plan, context);
    if (consumers > 0) {
      consumingPaths++;
    } else {
      skippedPaths++;
    }
  }
  expect(consumingPaths).toBeGreaterThan(0);
  expect(skippedPaths).toBeGreaterThan(0);
});

test("Bun setup contract rejects duplicate setup and missing setup fixtures", () => {
  const setup = (step: (typeof plan.steps)[number]) =>
    step.uses?.startsWith("stella/.github/actions/setup-bun-cached@");
  expect(plan.steps.filter(setup)).toHaveLength(1);
  const duplicate = {
    ...plan,
    steps: plan.steps.flatMap((step) => (setup(step) ? [step, step] : [step])),
  };
  const missing = { ...plan, steps: plan.steps.filter((step) => !setup(step)) };
  const context =
    contexts.find(
      ({ values }) =>
        values["github.event_name"] === "merge_group" &&
        values["steps.depth.outputs.queue_depth"] === "thin" &&
        values["steps.check.outputs.trusted"] === "true" &&
        values["steps.completed-depth.outputs.run_required"] === "true",
    ) ?? panic("Missing trusted thin-queue fixture");
  expect(assertBunSetupContract(plan, context).consumers).toBeGreaterThan(0);
  expect(() => assertBunSetupContract(duplicate, context)).toThrow(
    "Bun setup count",
  );
  expect(() => assertBunSetupContract(missing, context)).toThrow(
    "Bun setup count",
  );
});
