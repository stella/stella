import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  MCP_TOOL_READ_BUDGETS,
  READ_BUDGETS,
  UNGOVERNED_SCHEDULED_JOB_PAGE_CEILING,
} from "@/api/lib/db/read-budgets";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { MCP_STATIC_TOOL_NAMES } from "@/api/mcp/static-tool-names";
import {
  SCHEDULED_JOB_MEASUREMENTS,
  scheduledJobMeasurementViolations,
} from "@/api/tests/query-perf/registry";

import {
  ledgerMergeBase,
  parseReasonedLedger,
  runLedgerMembershipGuard,
} from "../../../../../scripts/ledger-membership.ts";
import unmeasuredLedger from "./read-budgets-unmeasured.json";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const LEDGER = "apps/api/src/lib/db/read-budgets-unmeasured.json";
const unmeasured = new Set(
  parseReasonedLedger(JSON.stringify(unmeasuredLedger), LEDGER),
);

/**
 * A scheduled job or MCP tool that reads without a declared budget is how an
 * unbounded statement reaches production unmeasured. Every declaration is
 * checked here, without a database, so a new job or tool fails before the
 * gate that measures it is even scheduled.
 */
describe("read budget declarations", () => {
  test("every scheduled job declares its reads", () => {
    const governed = new Set<string>(Object.values(SCHEDULER_BACKFILL_IDS));
    const violations = DECLARED_SCHEDULER_JOBS.flatMap((job) => {
      const listed = unmeasured.has(`job:${job.id}`);
      if (job.reads === "unmeasured") {
        return listed
          ? []
          : [
              `${job.id}: unmeasured reads need a ledger entry; declare a budget instead`,
            ];
      }
      if (listed) {
        return [`${job.id}: declares its reads, so remove its ledger entry`];
      }
      const loadGoverned =
        job.reads === "load-governed" || "governance" in job.reads;
      if (loadGoverned && !governed.has(job.id)) {
        return [
          `${job.id}: only jobs that batch through the backfill runtime are load-governed`,
        ];
      }
      if (job.reads === "load-governed" || "governance" in job.reads) {
        return [];
      }
      // Widened: the check holds for every budget a job may declare later.
      const pages: number = READ_BUDGETS[job.reads.budget].pages;
      const ceiling: number = UNGOVERNED_SCHEDULED_JOB_PAGE_CEILING;
      return pages <= ceiling
        ? []
        : [
            `${job.id}: ${String(pages)} pages per run is over the ${String(ceiling)}-page ceiling for a job outside the load governor`,
          ];
    });
    expect(violations).toEqual([]);
  });

  test("every budgeted job has a measurement of its own", () => {
    expect(
      scheduledJobMeasurementViolations(
        DECLARED_SCHEDULER_JOBS,
        SCHEDULED_JOB_MEASUREMENTS,
      ),
    ).toEqual([]);
  });

  test("a second job sharing a measured budget still needs its own measurement", () => {
    const freshness = DECLARED_SCHEDULER_JOBS.find(
      ({ id }) => id === "caseLaw.reportFreshness.fiveMinute",
    );
    expect(freshness?.reads).toEqual({
      budget: "scheduled.caseLaw.reportFreshness",
    });
    const jobs = [
      ...DECLARED_SCHEDULER_JOBS,
      {
        id: "caseLaw.reportFreshness.copy",
        task: "caseLaw.reportFreshness",
        reads: { budget: "scheduled.caseLaw.reportFreshness" },
      } as const,
    ];
    expect(
      scheduledJobMeasurementViolations(jobs, SCHEDULED_JOB_MEASUREMENTS),
    ).toEqual([
      "caseLaw.reportFreshness.copy declares scheduled.caseLaw.reportFreshness but has no measurement keyed by its id",
    ]);
    expect(
      scheduledJobMeasurementViolations(DECLARED_SCHEDULER_JOBS, {
        ...SCHEDULED_JOB_MEASUREMENTS,
        "inboundMail.receive.minutely": {
          task: "inboundMail.receive",
          scenarios: [],
        },
      }),
    ).toEqual([
      "inboundMail.receive.minutely is measured but declares no read budget",
    ]);
  });

  test("every governed backfill is declared as governed", () => {
    for (const id of Object.values(SCHEDULER_BACKFILL_IDS)) {
      expect(
        DECLARED_SCHEDULER_JOBS.find((job) => job.id === id)?.reads,
        id,
      ).toSatisfy(
        (reads) =>
          reads === "load-governed" ||
          (typeof reads === "object" && "governance" in reads),
      );
    }
  });

  test("every MCP tool has a budget or a ledger entry, never both", () => {
    const budgeted = new Set<string>(Object.keys(MCP_TOOL_READ_BUDGETS));
    const violations = MCP_STATIC_TOOL_NAMES.flatMap((tool) => {
      const listed = unmeasured.has(`mcp:${tool}`);
      if (budgeted.has(tool) === listed) {
        return [
          `${tool}: ${listed ? "has a budget and a ledger entry" : "declares no read budget"}`,
        ];
      }
      return [];
    });
    expect(violations).toEqual([]);
  });

  test("the ledger names only declared jobs and tools", () => {
    const known = new Set([
      ...DECLARED_SCHEDULER_JOBS.map(({ id }) => `job:${id}`),
      ...MCP_STATIC_TOOL_NAMES.map((tool) => `mcp:${tool}`),
    ]);
    expect([...unmeasured].filter((id) => !known.has(id))).toEqual([]);
  });

  test("the unmeasured ledger only shrinks", () => {
    expect(
      runLedgerMembershipGuard({
        ledgerRel: LEDGER,
        repoRoot,
        parseLedger: parseReasonedLedger,
        label: "read-budgets-unmeasured",
        remediation: "declare a read budget and measure it instead",
        args: ["--base", ledgerMergeBase({ repoRoot, baseRef: "origin/main" })],
      }),
    ).toBe(0);
  });

  test("an over-budget entry is a measured statement with a reason", () => {
    for (const [id, budget] of Object.entries(READ_BUDGETS)) {
      if ("overBudget" in budget) {
        expect(budget.surface, id).toBe("statement");
        expect(budget.overBudget.reason.trim().length, id).toBeGreaterThan(0);
      }
      expect(Number.isInteger(budget.pages) && budget.pages > 0, id).toBe(true);
    }
  });
});
