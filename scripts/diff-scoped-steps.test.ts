import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { DIFF_SCOPED_STEPS, readsBaseRevision } from "./diff-scoped-steps";
import { workflowJobSteps } from "./workflow-steps";

const WORKFLOWS = ".github/workflows";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Every leaf step of every workflow job, pooled checks included.
const liveDiffScopedSteps = () => {
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
        if (readsBaseRevision(step)) {
          keys.push(`${file}:${job}#${String(step["name"] ?? step["uses"])}`);
        }
      }
    }
  }
  return keys;
};

test("every step that reads a base revision carries a scope decision", () => {
  const live = liveDiffScopedSteps();
  expect(new Set(live).size).toBe(live.length);
  expect(live.toSorted()).toEqual(Object.keys(DIFF_SCOPED_STEPS).toSorted());
  for (const decision of Object.values(DIFF_SCOPED_STEPS)) {
    expect(decision.reason.length).toBeGreaterThan(15);
  }
});

test("a base reaches the census through the script, env, inputs or a script it runs", () => {
  expect(
    readsBaseRevision({ run: 'bun check.ts --base "origin/$BASE_REF"' }),
  ).toBe(true);
  expect(
    readsBaseRevision({ run: "bun check.ts", env: { BASE_SHA: "x" } }),
  ).toBe(true);
  expect(
    readsBaseRevision({ uses: "./action", with: { "base-sha": "x" } }),
  ).toBe(true);
  // check-bridge-version.sh reads GITHUB_BASE_REF itself.
  expect(
    readsBaseRevision({ run: "bash scripts/check-bridge-version.sh" }),
  ).toBe(true);
  // A literal revision passed as the base.
  expect(readsBaseRevision({ run: "bun check.ts --base HEAD^1" })).toBe(true);
  expect(readsBaseRevision({ run: "bun check.ts --base 'origin/main'" })).toBe(
    true,
  );
  expect(
    readsBaseRevision({
      run: "bun check.ts --base 0123456789abcdef0123456789abcdef01234567",
    }),
  ).toBe(true);
  // A pull request's target branch or a baseline file is not a revision.
  expect(readsBaseRevision({ run: "gh pr create --base main" })).toBe(false);
  expect(
    readsBaseRevision({ run: 'bun durations.ts --base "$RUNNER_TEMP/d.json"' }),
  ).toBe(false);
  // A classification label is prose, not a base.
  expect(
    readsBaseRevision({
      run: "bun check.ts --all",
      env: { CI_CHECK_CONTEXT: "Uses the merge-base." },
    }),
  ).toBe(false);
});
