import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

// Base schema, seed and the contending writer before the upgrade starts:
// measured 5 min 23 s on a hosted runner (10-19), with headroom.
const SETUP_ALLOWANCE_MINUTES = 8;
// Checkout, install and image pulls before the rehearsal step.
const JOB_SETUP_ALLOWANCE_MINUTES = 4;

const script = readFileSync(
  new URL("rehearse-migration-upgrade.sh", import.meta.url),
  "utf-8",
);
const workflow = v.parse(
  v.object({
    jobs: v.looseObject({
      "migration-upgrade-rehearsal": v.looseObject({
        "timeout-minutes": v.number(),
        steps: v.array(
          v.looseObject({
            name: v.optional(v.string()),
            "timeout-minutes": v.optional(v.number()),
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

// The script owns the rehearsal budgets; the workflow cap must never cut the
// rehearsal short inside them (it did: a 9 min step against a 900 s budget).
test("the rehearsal step and job timeouts derive from the script's own budget", () => {
  const budgetSeconds = Number(
    /^budget="\$\{REHEARSAL_MIGRATE_BUDGET_SECONDS:-(\d+)\}"$/mu.exec(
      script,
    )?.[1],
  );
  expect(Number.isInteger(budgetSeconds) && budgetSeconds > 0).toBe(true);
  // The upgrade and its fixed-point rerun each run under the budget.
  expect(script.match(/timeout --foreground "\$budget"/gu)).toHaveLength(2);

  const job = workflow.jobs["migration-upgrade-rehearsal"];
  const step = job.steps.find(
    ({ name }) =>
      name === "Rehearse the upgrade from the promoted release at scale",
  );
  const stepMinutes =
    SETUP_ALLOWANCE_MINUTES + Math.ceil((2 * budgetSeconds) / 60);
  expect(step?.["timeout-minutes"]).toBe(stepMinutes);
  expect(job["timeout-minutes"]).toBe(
    stepMinutes + JOB_SETUP_ALLOWANCE_MINUTES,
  );
});
