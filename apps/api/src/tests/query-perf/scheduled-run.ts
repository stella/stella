import { panic, Result } from "better-result";
import { type Logger, type SQL, sql } from "drizzle-orm";
import * as v from "valibot";

import { computeCaseLawCoverageAnswer } from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import { createCaseLawCoverageRefreshTask } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  explainOwnerStatement,
  metricsFromPlan,
  type QueryPerfMetrics,
  sumMetrics,
} from "./measurement";
import { QUERY_PERF_OWNER_DEADLINES } from "./owner-deadlines";
import { analyzePlan, type PlanViolation } from "./plan-analyzer";
import { rollbackTaskDatabase, withQueryPerfRollback } from "./rollback";
import {
  applyPlannerSettings,
  assertPlannerSettings,
  QUERY_PERF_CONNECTION_SETTINGS,
} from "./settings";

type CapturedStatement = { text: string; params: readonly unknown[] };

/** The statement's leading keyword, after comments and whitespace. */
const leadingKeyword = (text: string) =>
  /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*([a-z]+)/iu
    .exec(text)
    ?.at(1)
    ?.toLowerCase() ?? "";

const SESSION_KEYWORDS: ReadonlySet<string> = new Set(["set", "reset", "show"]);
const PLAN_KEYWORDS: ReadonlySet<string> = new Set([
  "insert",
  "update",
  "delete",
  "select",
  "with",
  "values",
]);

/** A captured statement as a Drizzle query with the same bound parameters. */
const asQuery = ({ text, params }: CapturedStatement): SQL => {
  const parts = text.split(/\$(\d+)/u);
  const chunks = parts.map((part, index) => {
    if (index % 2 === 0) {
      return sql.raw(part);
    }
    const position = Number(part) - 1;
    if (position < 0 || position >= params.length) {
      return panic(`Captured statement names missing parameter $${part}`);
    }
    // One bound value each, as captured: an array stays one array parameter.
    return sql.param(params[position]);
  });
  return sql.join(chunks, sql.raw(""));
};

const noopTask = () => undefined;

/**
 * Run the registered task inside a rollback envelope, then replay every data
 * statement in order with EXPLAIN ANALYZE in another rollback envelope. Writes
 * see the same earlier writes as the task did, and neither pass consumes the
 * next scenario's fixture. Capture enforces transaction controls; replay
 * measures every data statement and preserves explicit table locks.
 */
export const measureScheduledJobRun = async ({
  database,
  openClient,
  jobId,
  task: taskName,
}: {
  database: GatedTestDb;
  openClient: GatedTestClientScope["openClient"];
  jobId: string;
  task: string;
}) => {
  const job =
    DECLARED_SCHEDULER_JOBS.find(({ id }) => id === jobId) ??
    panic(`No declared scheduler job ${jobId}`);
  if (job.task !== taskName) {
    return panic(`${jobId} runs ${job.task}, not ${taskName}`);
  }
  const readBudgetId =
    typeof job.reads === "object"
      ? job.reads.budget
      : panic(`${jobId} has no measured read budget`);
  const task =
    createSchedulerTaskRegistry(
      noopTask,
      createCaseLawCoverageRefreshTask({
        compute: computeCaseLawCoverageAnswer,
      }),
    ).get(job.task) ?? panic(`No registered task ${job.task} for ${jobId}`);
  const captured: CapturedStatement[] = [];
  const logger: Logger = {
    logQuery: (text, params) => {
      captured.push({ text, params });
    },
  };
  const { db } = openClient({
    connection: QUERY_PERF_CONNECTION_SETTINGS,
    logger,
  });
  // This isolated corpus fixture has one task-written identity sequence. Its
  // values survive rollback; restoring it keeps captured log-id parameters
  // attached to the same rows when the task's writes are replayed.
  const sequence = v.parse(
    v.object({ last_value: v.bigint(), is_called: v.boolean() }),
    executedRows(
      await db.execute(
        sql`SELECT last_value, is_called FROM case_law_sitemap_changes_id_seq`,
      ),
    ).at(0),
  );
  captured.length = 0;
  try {
    const outcome = await withQueryPerfRollback(
      db,
      async (tx) =>
        await task(
          asTestRaw<SchedulerTaskContext>({
            db: rollbackTaskDatabase(db, tx),
            job: { id: job.id, task: job.task },
            payload: null,
            dueAt: DueSlot.of({ nextRunAt: new Date("2000-01-01") }),
            runId: createSafeId<"schedulerJobRun">(),
            signal: new AbortController().signal,
            scheduleContinuation: noopTask,
            logger: {
              debug: noopTask,
              error: noopTask,
              info: noopTask,
              warn: noopTask,
            },
          }),
        ),
    );
    if (outcome !== undefined && !Result.isOk(outcome)) {
      return panic(`${jobId} failed on the fixture: ${outcome.error.message}`);
    }
    const replay = captured.filter(({ text }) => {
      const keyword = leadingKeyword(text);
      if (SESSION_KEYWORDS.has(keyword)) {
        return false;
      }
      if (!PLAN_KEYWORDS.has(keyword) && keyword !== "lock") {
        return panic(
          `${jobId} issued a ${keyword || "blank"} statement; no query-perf replay is defined for it`,
        );
      }
      return true;
    });
    if (replay.length === 0) {
      return panic(`${jobId} issued no statement to measure`);
    }
    const statements = await withQueryPerfRollback(database, async (tx) => {
      await tx.execute(
        sql`SELECT setval('case_law_sitemap_changes_id_seq', ${sequence.last_value}, ${sequence.is_called})`,
      );
      await applyPlannerSettings(tx);
      const measured: {
        metrics: QueryPerfMetrics;
        planViolations: PlanViolation[];
        statement: string;
      }[] = [];
      for (const statement of replay) {
        // db-await-in-loop: the run's statements are analyzed one at a time, in the order the job issued them.
        if (leadingKeyword(statement.text) === "lock") {
          await tx.execute(asQuery(statement));
          continue;
        }
        const plan = await explainOwnerStatement(tx, asQuery(statement));
        const normalized = statement.text
          .replaceAll(/\s+/gu, " ")
          .slice(0, 160);
        measured.push({
          metrics: metricsFromPlan(plan),
          planViolations: analyzePlan({
            document: plan,
            owner: jobId,
            ownerDeadlineMs: QUERY_PERF_OWNER_DEADLINES[readBudgetId],
            statement: normalized,
            profileId: "corpus",
          }),
          statement: normalized,
        });
      }
      await assertPlannerSettings(tx, "owner");
      return measured;
    });
    return {
      metrics: sumMetrics(statements.map(({ metrics }) => metrics)),
      planViolations: statements.flatMap(
        ({ planViolations }) => planViolations,
      ),
      statements,
    };
  } finally {
    await db.execute(
      sql`SELECT setval('case_law_sitemap_changes_id_seq', ${sequence.last_value}, ${sequence.is_called})`,
    );
  }
};
