import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { type Context, evaluate } from "./github-expression";
import { flattenWorkflowSteps } from "./workflow-steps";

const configured = v.parse(
  v.object({
    on: v.record(v.string(), v.unknown()),
    jobs: v.object({
      "ci-plan": v.object({
        if: v.string(),
        steps: v.pipe(
          v.unknown(),
          v.transform((steps) => flattenWorkflowSteps(steps)),
          v.array(
            v.object({
              id: v.optional(v.string()),
              name: v.string(),
              if: v.optional(v.string()),
              uses: v.optional(v.string()),
              run: v.optional(v.string()),
              with: v.optional(v.record(v.string(), v.unknown())),
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
  // The planner installs Bun once from the trusted tooling copy before the
  // checkout and once from the checkout's own package.json; each version
  // source is set up at most once and every consumer runs after a setup.
  const setups = new Map<string, number>();
  let consumers = 0;
  if (!enabled(candidate.if)) {
    return { setups: 0, consumers };
  }
  for (const step of candidate.steps) {
    const runs = enabled(step.if);
    if (runs && step.uses?.startsWith("oven-sh/setup-bun@")) {
      const source = String(step.with?.["bun-version-file"]);
      setups.set(source, (setups.get(source) ?? 0) + 1);
      expect(setups.get(source), `Bun setup count for ${source}`).toBe(1);
    }
    if (
      runs &&
      (/\bbun\b/u.test(step.run ?? "") ||
        step.uses === "$/.github/actions/ci-install" ||
        step.uses === "./.github/actions/ci-install")
    ) {
      consumers++;
      expect(
        setups.size,
        `Bun setup count before ${step.name}`,
      ).toBeGreaterThan(0);
    }
    if (step.id) {
      values[`steps.${step.id}.outcome`] = runs ? "success" : "skipped";
    }
  }
  expect(
    consumers > 0 || setups.size === 0,
    "Bun setup count at job completion",
  ).toBe(true);
  return { setups: setups.size, consumers };
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
  // Read by the patch-id steps: an enqueued head computes no patch identity.
  ["github.event.action", ["synchronize", "enqueued"]],
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
  ["steps.changed-files.outputs.legal_atlas_image_required", ["true"]],
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
    if (
      event !== "pull_request" &&
      values["github.event.action"] === "enqueued"
    ) {
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
  .flatMap((values) => {
    // The lookup publishes arming only for a PR code run. Queue entries and
    // reusable callers keep it unset; they select heavy planning by event/input.
    const armedOutputs =
      values["github.event_name"] === "pull_request" &&
      values["github.event.action"] !== "enqueued" &&
      values["inputs.heavy_only"] !== true &&
      values["github.event.pull_request.draft"] !== true
        ? ["false", "true"]
        : [""];
    return armedOutputs.map((armed) => {
      const armedValues = { ...values };
      armedValues["steps.completed-depth.outputs.armed"] = armed;
      return {
        values: armedValues,
        status: {
          always: true,
          success: true,
          failure: false,
          cancelled: false,
        },
      } satisfies Context;
    });
  });

test("ci-plan sets up Bun exactly once before every Bun consumer across event, depth, trust and arming branches", () => {
  let consumingPaths = 0;
  let skippedPaths = 0;
  const consumedArmingStates = { false: 0, true: 0 };
  for (const context of contexts) {
    const { consumers } = assertBunSetupContract(plan, context);
    if (consumers > 0) {
      consumingPaths++;
      const armed = context.values["steps.completed-depth.outputs.armed"];
      if (armed === "true" || armed === "false") {
        consumedArmingStates[armed]++;
      }
    } else {
      skippedPaths++;
    }
  }
  expect(consumingPaths).toBeGreaterThan(0);
  expect(skippedPaths).toBeGreaterThan(0);
  expect(consumedArmingStates.false).toBeGreaterThan(0);
  expect(consumedArmingStates.true).toBeGreaterThan(0);
});

test("Bun setup contract rejects duplicate setup and missing setup fixtures", () => {
  const setup = (step: (typeof plan.steps)[number]) =>
    step.uses?.startsWith("oven-sh/setup-bun@");
  expect(
    plan.steps.filter(setup).map((step) => step.with?.["bun-version-file"]),
  ).toEqual([".workflow-tooling/package.json", "package.json"]);
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
