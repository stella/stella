import { expect, test } from "bun:test";
import { getTableConfig, pgSchema, text } from "drizzle-orm/pg-core";

import {
  FLOW_RUN_STATUSES,
  FLOW_RUN_TERMINAL_STATUSES,
} from "@stll/api-contract";

import { flowRuns } from "@/api/db/schema";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import {
  transitionDomainSql,
  transitionTriggerSql,
} from "@/api/lib/db/transition-sql";
import { defineTransitions, permitsTransition } from "@/api/lib/db/transitions";

test("the committed trigger and status-domain check derive from the declared graph", async () => {
  const migration = await Bun.file(
    new URL(
      "../../../drizzle/20261003124600_flow_run_transitions/migration.sql",
      import.meta.url,
    ),
  ).text();
  expect(migration).toContain(transitionTriggerSql(TRANSITIONS.flowRuns));
  expect(migration).toContain(
    transitionDomainSql(TRANSITIONS.flowRuns).trimEnd(),
  );
  expect(getTableConfig(flowRuns).checks.map(({ name }) => name)).toContain(
    "flow_runs_status_domain",
  );
});

test("canonical terminal flow states have no escape even when both generators agree", () => {
  expect(TRANSITIONS.flowRuns.terminal).toEqual(FLOW_RUN_TERMINAL_STATUSES);
  for (const from of FLOW_RUN_TERMINAL_STATUSES) {
    for (const to of FLOW_RUN_STATUSES) {
      expect(permitsTransition(TRANSITIONS.flowRuns, from, to)).toBe(
        from === to,
      );
    }
  }
});

test("schema-qualified tables and mapped status columns share one SQL identity", () => {
  const table = pgSchema("other").table("mapped_jobs", {
    id: text().primaryKey(),
    status: text("lifecycle_status", { enum: ["done"] }).notNull(),
  });
  const spec = defineTransitions(table, { done: [] }, { terminal: ["done"] });
  expect(transitionDomainSql(spec)).toContain(
    'ALTER TABLE "other"."mapped_jobs"',
  );
  expect(transitionDomainSql(spec)).toContain('CHECK ("lifecycle_status" IN');
  expect(transitionTriggerSql(spec)).toContain(
    'UPDATE OF "lifecycle_status" ON "other"."mapped_jobs"',
  );
  expect(transitionTriggerSql(spec)).toContain(
    'FUNCTION "other"."mapped_jobs_status_transition_guard"',
  );
});
