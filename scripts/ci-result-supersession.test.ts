import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

const workflow = v.parse(
  v.object({
    jobs: v.object({
      "ci-result": v.object({
        steps: v.array(
          v.looseObject({
            name: v.optional(v.string()),
            run: v.optional(v.string()),
          }),
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
const outcome = workflow.jobs["ci-result"].steps.find(
  ({ name }) => name === "Evaluate CI outcome",
)?.run;
if (!outcome) {
  throw new Error("Missing CI outcome evaluator");
}

test("the required-jobs artifact keeps its exact external schema", () => {
  const record =
    /\| \{version: 1, event: \$event,[\s\S]*?verdict: \(if \$status == "0" then "success" else "failure" end\)\}/u.exec(
      outcome,
    )?.[0];
  expect(record).toBeDefined();
  expect(
    [...(record ?? "").matchAll(/(?:\{|,)\s*([a-z_]+):/gu)].map(
      ([, field]) => field,
    ),
  ).toEqual([
    "version",
    "event",
    "head_sha",
    "base_sha",
    "run_id",
    "run_attempt",
    "depth",
    "coverage_profile",
    "reused_from_run_id",
    "basis",
    "pass_through_reason",
    "required",
    "job",
    "conclusion",
    "not_required",
    "verdict",
  ]);
});

test("metadata mirroring and verified supersession remain fail closed", () => {
  expect(outcome).toContain("mirror_metadata_code_run");
  expect(outcome).toContain("Metadata mirror could not list CI code runs.");
  expect(outcome).toContain(
    "Cancelled CI job failed-step lookup was unavailable.",
  );
  expect(outcome).toContain("cancelled_dependencies_were_superseded");
  expect(outcome).toContain("CI run was superseded by a newer run");
});
