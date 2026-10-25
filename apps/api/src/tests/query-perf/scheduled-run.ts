import { panic, Result } from "better-result";
import { type Logger, type SQL, sql } from "drizzle-orm";

import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { explainOwnerStatement, metricsFromPlan } from "./measurement";
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
const READ_KEYWORDS: ReadonlySet<string> = new Set([
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
    return sql`${params[position]}`;
  });
  return sql.join(chunks, sql.raw(""));
};

const noopTask = () => undefined;

/**
 * Pages one run of a declared job reads. The job's registered task runs once
 * against the fixture through a client that records every statement it
 * issues; each recorded read is then analyzed in one transaction under the
 * committed planner settings, and the run costs the sum. Measuring the task
 * rather than a hand-kept list of its statements means a statement added to
 * the job is measured without anyone registering it.
 *
 * Only reading jobs are measured this way: a write would change the fixture
 * the next scenario reads, so a job that writes fails here until its replay
 * runs inside a rolled-back transaction.
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
  const task =
    createSchedulerTaskRegistry(noopTask).get(job.task) ??
    panic(`No registered task ${job.task} for ${jobId}`);
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
  const outcome = await task(
    asTestRaw<SchedulerTaskContext>({
      db,
      job: { id: job.id, task: job.task },
      payload: null,
      signal: new AbortController().signal,
      scheduleContinuation: noopTask,
      logger: {
        debug: noopTask,
        error: noopTask,
        info: noopTask,
        warn: noopTask,
      },
    }),
  );
  if (outcome !== undefined && !Result.isOk(outcome)) {
    return panic(`${jobId} failed on the fixture: ${outcome.error.message}`);
  }
  const reads = captured.filter(({ text }) => {
    const keyword = leadingKeyword(text);
    if (SESSION_KEYWORDS.has(keyword)) {
      return false;
    }
    if (!READ_KEYWORDS.has(keyword)) {
      return panic(
        `${jobId} issued a ${keyword || "blank"} statement; a writing job needs a rolled-back replay before it can be measured`,
      );
    }
    return true;
  });
  if (reads.length === 0) {
    return panic(`${jobId} issued no statement to measure`);
  }
  const statements = await database.transaction(async (tx) => {
    await applyPlannerSettings(tx);
    const measured: { pages: number; statement: string }[] = [];
    for (const statement of reads) {
      // db-await-in-loop: the run's statements are analyzed one at a time, in the order the job issued them.
      const plan = await explainOwnerStatement(tx, asQuery(statement));
      measured.push({
        pages: metricsFromPlan(plan).sharedBlocks,
        statement: statement.text.replaceAll(/\s+/gu, " ").slice(0, 160),
      });
    }
    await assertPlannerSettings(tx, "owner");
    return measured;
  });
  return {
    pages: statements.reduce((total, { pages }) => total + pages, 0),
    statements,
  };
};
