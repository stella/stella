import { panic } from "better-result";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  affectedPackages,
  readSelectionGraph,
  requiresFullSelection,
  type SelectionGraph,
  withDerivedOutputs,
} from "./ci-affected-selection";
import {
  type ReadCheckPool,
  readWorkingTreeCheckPool,
} from "./ci-check-pool-registry";
import { rootCheckGate } from "./ci-root-check-gate";
import declaredInputs from "./ci-root-check-inputs.json" with { type: "json" };
import { flattenWorkflowSteps } from "./workflow-steps";

const root = path.resolve(import.meta.dir, "..");
const stepSchema = v.looseObject({
  name: v.string(),
  id: v.optional(v.string()),
  run: v.optional(v.string()),
  if: v.optional(v.string()),
});
const workflowSchema = v.object({ jobs: v.record(v.string(), v.unknown()) });
const jobSchema = v.looseObject({ steps: v.array(stepSchema) });
const checkInputsSchema = v.record(v.string(), v.array(v.string()));
const inputsSchema = v.strictObject({
  "ci-checks-rest": checkInputsSchema,
  "ci-checks-policy": checkInputsSchema,
  "code-quality-web-rest": checkInputsSchema,
});
const toolingPackages = [
  "@stll/scripts",
  "@stll/property-testing",
  "@stll/collation",
  "@stll/portable-path",
];

export const ROOT_CHECK_INPUTS = v.parse(inputsSchema, declaredInputs);
export const rootCheckInputs = (graph: SelectionGraph) =>
  new Map(
    Object.entries(ROOT_CHECK_INPUTS).flatMap(([job, checks]) =>
      Object.entries(checks).map(([name, inputs]) => {
        const sources = inputs.flatMap((input) => {
          if (!input.startsWith("@task/")) {
            return [input];
          }
          const task = input.slice("@task/".length);
          const participants = [...graph.packages]
            .filter(([, owner]) => owner.scripts[task] !== undefined)
            .map(([packageName]) => packageName);
          if (participants.length === 0) {
            panic(`Root check names an unknown workspace task: ${task}`);
          }
          return participants;
        });
        return [
          `${job}/${name}`,
          sources.includes("**") ? sources : [...sources, ...toolingPackages],
        ] as const;
      }),
    ),
  );

// Reject missing and stale declarations. A new workflow check cannot inherit
// a narrow scope without an explicit input decision.
export const validateRootCheckCensus = (
  workflowSource: string,
  inputs = ROOT_CHECK_INPUTS,
  readPool: ReadCheckPool = readWorkingTreeCheckPool,
) => {
  const workflow = v.parse(workflowSchema, Bun.YAML.parse(workflowSource));
  for (const [job, checks] of Object.entries(inputs)) {
    const { steps: declaredSteps } = v.parse(
      jobSchema,
      workflow.jobs[job] ?? panic(`Missing root job: ${job}`),
    );
    // Pooled checks are steps of their job for selection purposes.
    const steps = v.parse(
      v.array(stepSchema),
      flattenWorkflowSteps(declaredSteps, readPool),
    );
    const actual = steps
      .filter(({ run }) => run !== undefined)
      .map(({ name }) => name)
      .toSorted();
    const declared = Object.keys(checks).toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(declared)) {
      panic(`Root check input census differs: ${job}`);
    }
    for (const step of steps.filter(({ run }) => run !== undefined)) {
      const paths = checks[step.name] ?? panic("Missing root check inputs");
      const gate = rootCheckGate({ job, name: step.name });
      const gated = step.if?.includes(gate) === true;
      if (gated === paths.includes("**")) {
        panic(`Root check selection gate differs: ${job}/${step.name}`);
      }
      // A deselected step reports `skipped`: a later step that requires its
      // success or reads its outputs would silently skip or misread.
      const { id } = step;
      const consumed =
        id !== undefined &&
        steps.some(
          (other) =>
            other !== step &&
            [
              `steps.${id}.outputs.`,
              `steps.${id}.outcome == 'success'`,
              `steps.${id}.conclusion == 'success'`,
            ].some((use) => JSON.stringify(other).includes(use)),
        );
      if (gated && consumed) {
        panic(`Root check gate skips a consumed step: ${job}/${step.name}`);
      }
    }
  }
};

type SelectRootChecksOptions = {
  changed: readonly string[];
  graph: SelectionGraph;
  pathChange: "content" | "structure";
  inputs?: ReadonlyMap<string, readonly string[]>;
};
export const selectRootChecks = ({
  changed,
  graph,
  pathChange,
  inputs = rootCheckInputs(graph),
}: SelectRootChecksOptions) => {
  for (const paths of inputs.values()) {
    for (const input of paths) {
      if (input.startsWith("@") && !graph.packages.has(input)) {
        panic(`Unknown root-check package: ${input}`);
      }
    }
  }
  if (pathChange === "structure" || requiresFullSelection(changed, graph)) {
    return [...inputs.keys()];
  }
  // A package test that reads another package is not a source dependency of
  // these CLI checks. Their source imports follow the workspace graph only.
  const affected = affectedPackages(changed, { ...graph, inputs: new Map() });
  // CI restores derived outputs before these checks, so a path reader sees
  // the outputs of every changed generator input.
  const files = [...withDerivedOutputs(changed)];
  return [...inputs]
    .filter(([, paths]) =>
      paths.some((input) => {
        if (input === "**") {
          return true;
        }
        if (input.startsWith("@stll/")) {
          return affected.has(input);
        }
        return files.some(
          (file) => file === input || new Bun.Glob(input).match(file),
        );
      }),
    )
    .map(([check]) => check);
};

if (import.meta.main) {
  validateRootCheckCensus(
    readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
  );
  const graph = readSelectionGraph(root);
  const known =
    process.env["API_SCOPE_UNKNOWN"] !== "true" &&
    ["pull_request", "merge_group"].includes(process.env["EVENT_NAME"] ?? "");
  const changed = known
    ? readFileSync(
        path.join(
          process.env["RUNNER_TEMP"] ?? panic("Missing RUNNER_TEMP"),
          "api-test-changed-paths",
        ),
        "utf-8",
      )
        .split("\0")
        .filter(Boolean)
    : ["bun.lock"];
  const base = process.env["BASE_SHA"];
  const census =
    known && base
      ? Bun.spawnSync(
          [
            "git",
            "diff",
            "--name-only",
            "--no-renames",
            "--diff-filter=ACDRT",
            `${base}...HEAD`,
          ],
          { cwd: root, stdout: "pipe", stderr: "pipe" },
        )
      : undefined;
  const pathChange =
    census?.exitCode === 0 && census.stdout.length === 0
      ? "content"
      : "structure";
  const options = { changed, graph, pathChange } as const;
  const selected = selectRootChecks(options);
  appendFileSync(
    process.env["GITHUB_OUTPUT"] ?? panic("Missing GITHUB_OUTPUT"),
    `root_checks=${JSON.stringify(selected)}\n`,
  );
}
