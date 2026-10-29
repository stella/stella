import { panic, Result } from "better-result";
import {
  type Logger,
  type SQL,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";

import { computeCaseLawCoverageAnswer } from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import { createCaseLawCoverageRefreshTask } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import type { DataExportMaintenanceDependencies } from "@/api/lib/scheduler/tasks/data-export-maintenance";
import type {
  SchedulerDb,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";
import { createLeasedSchedulerJobFixture } from "@/api/tests/helpers/leased-scheduler-job";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  explainOwnerStatement,
  metricsFromPlan,
  type QueryPerfMetrics,
  sumMetrics,
} from "./measurement";
import {
  applyPlannerSettings,
  assertPlannerSettings,
  QUERY_PERF_CONNECTION_SETTINGS,
} from "./settings";

export type CapturedStatement = { text: string; params: readonly unknown[] };

/** The statement's leading keyword, after comments and whitespace. */
const leadingKeyword = (text: string) =>
  /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*([a-z]+)/iu
    .exec(text)
    ?.at(1)
    ?.toLowerCase() ?? "";

const SESSION_KEYWORDS: ReadonlySet<string> = new Set(["set", "reset", "show"]);
const TRANSACTION_KEYWORDS = new Set([
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
]);
const MEASURED_KEYWORDS: ReadonlySet<string> = new Set([
  "select",
  "with",
  "values",
  "delete",
  "insert",
  "update",
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

type CaptureScheduledJobOptions = {
  database: SchedulerDb;
  jobId: string;
  task: string;
  statements: readonly CapturedStatement[];
  now?: Date;
  dataExportMaintenance?: DataExportMaintenanceDependencies;
  resetAfterCapture?: () => Promise<void>;
};

/** Capture global-owner writers with real transactions; borrowed-role writers need a scope-aware replay. */
export const captureScheduledJobRun = async ({
  database,
  jobId,
  task: taskName,
  statements,
  now = new Date("2026-01-10T12:00:00Z"),
  dataExportMaintenance,
  resetAfterCapture,
}: CaptureScheduledJobOptions) => {
  const job =
    DECLARED_SCHEDULER_JOBS.find(({ id }) => id === jobId) ??
    panic(`No declared scheduler job ${jobId}`);
  if (job.task !== taskName) {
    panic(`${jobId} runs ${job.task}, not ${taskName}`);
  }
  const task =
    createSchedulerTaskRegistry(
      noopTask,
      createCaseLawCoverageRefreshTask({
        compute: computeCaseLawCoverageAnswer,
      }),
      dataExportMaintenance === undefined ? {} : { dataExportMaintenance },
    ).get(job.task) ?? panic(`No registered task ${job.task} for ${jobId}`);
  const outcome = await Result.tryPromise({
    try: async () =>
      await task(
        asTestRaw<SchedulerTaskContext>({
          runId: createSafeId<"schedulerJobRun">(),
          db: database,
          dueAt: DueSlot.of({ nextRunAt: now, lockedAt: now }),
          job: createLeasedSchedulerJobFixture({
            id: job.id,
            task: job.task,
            nextRunAt: now,
            payload: "payload" in job ? job.payload : null,
          }),
          payload: "payload" in job ? job.payload : null,
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
    catch: (error: unknown) => error,
  });
  const wrote = statements.some(({ text }) =>
    ["insert", "update", "delete"].includes(leadingKeyword(text)),
  );
  if (wrote && resetAfterCapture === undefined) {
    panic(`${jobId} writes require an explicit fixture reset before replay`);
  }
  const unsupportedScope =
    resetAfterCapture !== undefined &&
    statements.some(
      ({ text, params }) =>
        SESSION_KEYWORDS.has(leadingKeyword(text)) ||
        (/\bset_config\b/iu.test(text) &&
          (/['"]role['"]/iu.test(text) || params.includes("role"))),
    );
  await resetAfterCapture?.();
  if (unsupportedScope) {
    panic(
      `${jobId} writing captures support only global-owner scope without session or role changes`,
    );
  }
  if (outcome.isErr()) {
    panic(`${jobId} failed on the fixture`, outcome.error);
  }
  const result = outcome.value;
  if (result !== undefined && !Result.isOk(result)) {
    panic(`${jobId} failed on the fixture: ${result.error.message}`);
  }
};

/**
 * Pages one run of a declared job reads. The job's registered task runs once
 * against the fixture through a client that records every statement it
 * issues; each recorded read is then analyzed in one transaction under the
 * committed planner settings, and the run costs the sum. Measuring the task
 * rather than a hand-kept list of its statements means a statement added to
 * the job is measured without anyone registering it.
 *
 * Writing tasks commit normally on the disposable fixture, which their explicit
 * reset restores before analysis. Only global-owner writers are supported:
 * session commands and borrowed roles require a scope-aware replay. The
 * analyzed replay always rolls back.
 */
export const measureScheduledJobRun = async ({
  database,
  openClient,
  jobId,
  task: taskName,
  now = new Date("2026-01-10T12:00:00Z"),
  dataExportMaintenance,
  resetAfterCapture,
}: {
  database: GatedTestDb;
  openClient: GatedTestClientScope["openClient"];
  jobId: string;
  task: string;
  now?: Date;
  dataExportMaintenance?: DataExportMaintenanceDependencies;
  resetAfterCapture?: () => Promise<void>;
}) => {
  const captured: CapturedStatement[] = [];
  const logger: Logger = {
    logQuery: (text, params) => {
      captured.push({ text, params });
    },
  };
  const { db } = openClient({
    connection: {
      ...QUERY_PERF_CONNECTION_SETTINGS,
      default_transaction_read_only:
        resetAfterCapture === undefined ? "on" : "off",
    },
    logger,
  });
  await captureScheduledJobRun({
    database: db,
    jobId,
    task: taskName,
    statements: captured,
    now,
    ...(dataExportMaintenance === undefined ? {} : { dataExportMaintenance }),
    ...(resetAfterCapture === undefined ? {} : { resetAfterCapture }),
  });
  const reads = captured.filter(({ text }) => {
    const keyword = leadingKeyword(text);
    if (SESSION_KEYWORDS.has(keyword) || TRANSACTION_KEYWORDS.has(keyword)) {
      return false;
    }
    if (!MEASURED_KEYWORDS.has(keyword)) {
      return panic(
        `${jobId} issued an unsupported ${keyword || "blank"} statement`,
      );
    }
    return true;
  });
  if (reads.length === 0) {
    return panic(`${jobId} issued no statement to measure`);
  }
  const statements: { metrics: QueryPerfMetrics; statement: string }[] = [];
  const replay = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (tx) => {
        await applyPlannerSettings(tx);
        for (const statement of reads) {
          // db-await-in-loop: the run's statements are analyzed one at a time, in the order the job issued them.
          const plan = await explainOwnerStatement(tx, asQuery(statement));
          statements.push({
            metrics: metricsFromPlan(plan),
            statement: statement.text.replaceAll(/\s+/gu, " ").slice(0, 160),
          });
        }
        await assertPlannerSettings(tx, "owner");
        tx.rollback();
      }),
    catch: (error: unknown) => error,
  });
  if (replay.isOk() || !(replay.error instanceof TransactionRollbackError)) {
    return panic("Scheduled measurement replay must roll back", replay);
  }
  return {
    metrics: sumMetrics(statements.map(({ metrics }) => metrics)),
    statements,
  };
};
