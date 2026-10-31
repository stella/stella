import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import {
  DIFF_SCOPE_MARKER,
  DIFF_SCOPED_STEPS,
  type DiffScope,
  GAP_CEILING,
} from "./diff-scoped-steps";
import { workflowJobSteps } from "./workflow-steps";

const WORKFLOWS = ".github/workflows";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Every step that runs a script mentioning a base, pooled checks included.
const diffScopedSteps = () => {
  const keys: string[] = [];
  for (const file of readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml"))
    .toSorted()) {
    const workflow: unknown = Bun.YAML.parse(
      readFileSync(`${WORKFLOWS}/${file}`, "utf-8"),
    );
    if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
      continue;
    }
    for (const [job, definition] of Object.entries(workflow["jobs"])) {
      if (!isRecord(definition) || !Array.isArray(definition["steps"])) {
        continue;
      }
      for (const step of workflowJobSteps(workflow, job)) {
        const run = step["run"];
        if (typeof run !== "string") {
          continue;
        }
        if (
          DIFF_SCOPE_MARKER.test(run) ||
          DIFF_SCOPE_MARKER.test(JSON.stringify(step["env"] ?? {}))
        ) {
          keys.push(`${file}:${job}#${String(step["name"])}`);
        }
      }
    }
  }
  return keys;
};

test("every step that reads a base revision carries a scope decision", () => {
  const live = diffScopedSteps();
  expect(new Set(live).size).toBe(live.length);
  expect(live.toSorted()).toEqual(Object.keys(DIFF_SCOPED_STEPS).toSorted());
});

test("known scope gaps can only shrink", () => {
  const decisions: readonly DiffScope[] = Object.values(DIFF_SCOPED_STEPS);
  const gaps = decisions.filter(({ type }) => type === "gap");
  // Equality, not a bound: fixing a gap must lower the ceiling with it.
  expect(gaps).toHaveLength(GAP_CEILING);
  for (const decision of decisions) {
    expect(decision.reason.length).toBeGreaterThan(15);
  }
});

test("the census sees a new step that compares against the base", () => {
  expect(DIFF_SCOPE_MARKER.test('bun check.ts --base "origin/$BASE_REF"')).toBe(
    true,
  );
  expect(DIFF_SCOPE_MARKER.test("bun check.ts --all")).toBe(false);
});
