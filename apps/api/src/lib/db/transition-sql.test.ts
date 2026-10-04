import { expect, test } from "bun:test";
import { getTableConfig, pgSchema, text } from "drizzle-orm/pg-core";

import {
  FLOW_RUN_STATUSES,
  FLOW_RUN_TERMINAL_STATUSES,
} from "@stll/api-contract";

import { flowRuns } from "@/api/db/schema";
import { FLOW_TRANSITION_SPECS_V1 } from "@/api/lib/db/flow-run-transition-spec";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import {
  transitionDomainSql,
  transitionTriggerSql,
} from "@/api/lib/db/transition-sql";
import { defineTransitions, permitsTransition } from "@/api/lib/db/transitions";

import {
  transitionMigrationDirectory,
  transitionMigrationName,
} from "../../../scripts/generate-transition-triggers";

test("the committed trigger and status-domain check derive from the declared graph", async () => {
  const migration = await Bun.file(
    new URL("migration.sql", transitionMigrationDirectory()),
  ).text();
  for (const spec of FLOW_TRANSITION_SPECS_V1) {
    expect(migration).toContain(transitionTriggerSql(spec));
    expect(migration).toContain(transitionDomainSql(spec).trimEnd());
  }
  expect(getTableConfig(flowRuns).checks.map(({ name }) => name)).toContain(
    "flow_runs_status_domain",
  );
});

test("validation releases the prerequisite's exclusive lock before scanning", async () => {
  const validation = await Bun.file(
    new URL(
      "../../../drizzle/20261003124700_validate_flow_run_status/migration.sql",
      import.meta.url,
    ),
  ).text();
  const statements = validation
    .split("--> statement-breakpoint")
    .map((statement) => statement.replace(/^[ \t]*--[^\n]*/gmu, "").trim());
  const commit = statements.indexOf("COMMIT;");
  const begin = statements.indexOf("BEGIN;\nSET LOCAL lock_timeout = '1s';");
  expect(commit).toBeGreaterThanOrEqual(0);
  expect(begin).toBeGreaterThan(commit);
  const timeoutAssignments = statements.filter((sql) =>
    /^SET (?:LOCAL )?(?:lock_timeout|statement_timeout) =/u.test(sql),
  );
  expect(timeoutAssignments.length).toBeGreaterThan(0);
  for (const assignment of timeoutAssignments) {
    expect(assignment).toMatch(
      /^SET LOCAL (?:lock_timeout|statement_timeout) =/u,
    );
  }
  const scanTimeout = statements.indexOf("SET LOCAL statement_timeout = 0;");
  expect(scanTimeout).toBeGreaterThan(begin);
  for (const statement of statements.filter((sql) =>
    sql.includes("VALIDATE CONSTRAINT"),
  )) {
    expect(statements.indexOf(statement)).toBeGreaterThan(begin);
    expect(statements.indexOf(statement)).toBeGreaterThan(scanTimeout);
  }
  expect(
    statements.filter((sql) => sql.includes("VALIDATE CONSTRAINT")),
  ).toHaveLength(FLOW_TRANSITION_SPECS_V1.length);
});

test("the transition generator discovers a restamped migration without source edits", () => {
  expect(
    transitionMigrationName([
      "20261103123456_flow_run_transitions",
      "20261001000000_other",
    ]),
  ).toBe("20261103123456_flow_run_transitions");
  expect(() => transitionMigrationName([])).toThrow("Expected exactly one");
  expect(() =>
    transitionMigrationName([
      "20261001000000_flow_run_transitions",
      "20261002000000_flow_run_transitions",
    ]),
  ).toThrow("Expected exactly one");
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
