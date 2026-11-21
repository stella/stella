import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  CI_GATES,
  CONTINUE_ON_ERROR,
  CORRECTNESS_GUARDS,
} from "./ci-gate-classes";
import { flattenWorkflowSteps } from "./workflow-steps";

const Step = v.object({
  name: v.optional(v.string()),
  "continue-on-error": v.optional(v.union([v.boolean(), v.string()])),
});
const Workflow = v.object({
  jobs: v.record(v.string(), v.object({ steps: v.optional(v.unknown()) })),
});

const parsed = v.parse(
  Workflow,
  Bun.YAML.parse(
    await Bun.file(
      new URL("../.github/workflows/ci.yml", import.meta.url),
    ).text(),
  ),
);
// Checks a pool step runs (.github/ci-checks/<job>.yml) count as its job's
// steps: they carry their own continue-on-error.
const workflow = {
  jobs: Object.fromEntries(
    Object.entries(parsed.jobs).map(([job, spec]) => [
      job,
      {
        steps:
          spec.steps === undefined
            ? undefined
            : flattenWorkflowSteps(spec.steps).map((step) =>
                v.parse(Step, step),
              ),
      },
    ]),
  ),
};

test("every CI Checks job has a gate class and every classed job exists", () => {
  const jobs = Object.keys(workflow.jobs).toSorted();
  expect(Object.keys(CI_GATES).toSorted()).toEqual(jobs);
});

test("classed steps exist and carry the continue-on-error their class implies", () => {
  for (const [job, gate] of Object.entries(CI_GATES)) {
    const steps = workflow.jobs[job]?.steps ?? [];
    for (const [name, step] of Object.entries(gate.steps ?? {})) {
      const matches = steps.filter((candidate) => candidate.name === name);
      expect(matches.length, `${job} / ${name}`).toBe(1);
      expect(step.owner.length, `${job} / ${name} owner`).toBeGreaterThan(0);
      if (step.enforcedBy !== undefined) {
        continue;
      }
      expect(
        matches[0]?.["continue-on-error"],
        `${job} / ${name} continue-on-error`,
      ).toBe(CONTINUE_ON_ERROR[step.class]);
    }
  }
});

test("only classed steps soften failures, so no step is lenient by accident", () => {
  for (const [job, spec] of Object.entries(workflow.jobs)) {
    const classed = CI_GATES[job]?.steps ?? {};
    for (const step of spec.steps ?? []) {
      const lenience = step["continue-on-error"];
      if (lenience === undefined || lenience === false) {
        continue;
      }
      expect(
        step.name !== undefined && step.name in classed,
        `${job} / ${step.name ?? "(unnamed)"} sets continue-on-error without a gate class`,
      ).toBe(true);
    }
  }
});

test("correctness guards are never classed or softened in any job", () => {
  for (const [job, spec] of Object.entries(workflow.jobs)) {
    for (const step of spec.steps ?? []) {
      if (step.name === undefined || !(step.name in CORRECTNESS_GUARDS)) {
        continue;
      }
      expect(CI_GATES[job]?.steps?.[step.name], `${job} / ${step.name}`).toBe(
        undefined,
      );
      expect(step["continue-on-error"], `${job} / ${step.name}`).toBe(
        undefined,
      );
    }
  }
  for (const name of Object.keys(CORRECTNESS_GUARDS)) {
    expect(
      Object.values(workflow.jobs).some((spec) =>
        (spec.steps ?? []).some((step) => step.name === name),
      ),
      name,
    ).toBe(true);
  }
});
