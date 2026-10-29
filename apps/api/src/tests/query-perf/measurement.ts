import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { TransactionOf } from "@/api/db/scoped";
import { executedRows } from "@/api/lib/db/executed-rows";
import { READ_BUDGETS, type ReadBudgetId } from "@/api/lib/db/read-budgets";
import { isRecord } from "@/api/lib/type-guards";
import {
  explainAsStella,
  type ExplainPlanDocument,
} from "@/api/tests/explain-as-stella";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  scanOccurrences,
  withoutAuthorizationSubplans,
} from "@/api/tests/query-plans/plan-walker";

import { analyzePlan } from "./plan-analyzer";
import type { QueryPerfProfileId, QueryPerfTenantProfileId } from "./profiles";
import type { seedQueryPerf } from "./seed";
import {
  applyPlannerSettings,
  assertPlannerSettings,
  QUERY_PERF_JIT,
} from "./settings";

const QUERY_PERF_REPETITIONS = 5;
/**
 * Execution time is only a hang guard: buffers are the budget, and wall time
 * on a shared runner is not a measurement.
 */
const QUERY_PERF_HANG_GUARD_MS = 10_000;
export type QueryPerfMetrics = {
  sharedBlocks: number;
  executionTimeMs: number;
};

/** A scheduled run costs every statement's buffers and execution time. */
export const sumMetrics = (
  measurements: readonly QueryPerfMetrics[],
): QueryPerfMetrics => {
  let sharedBlocks = 0;
  let executionTimeMs = 0;
  for (const measured of measurements) {
    sharedBlocks += measured.sharedBlocks;
    executionTimeMs += measured.executionTimeMs;
  }
  return { sharedBlocks, executionTimeMs };
};

export const median = (values: readonly number[]) => {
  if (
    values.length === 0 ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    return panic("Query perf median requires nonnegative finite samples");
  }
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted.at(middle);
  if (upper === undefined) {
    return panic("Query perf median missing sample");
  }
  if (sorted.length % 2 !== 0) {
    return upper;
  }
  const lower = sorted.at(middle - 1);
  return lower === undefined
    ? panic("Query perf median missing sample")
    : (lower + upper) / 2;
};

export const metricsFromPlan = (
  document: ExplainPlanDocument,
): QueryPerfMetrics => {
  const time = document["Execution Time"];
  const hit = document.Plan["Shared Hit Blocks"];
  const read = document.Plan["Shared Read Blocks"];
  if (
    typeof time !== "number" ||
    typeof hit !== "number" ||
    typeof read !== "number" ||
    [time, hit, read].some((value) => !Number.isFinite(value) || value < 0)
  ) {
    return panic(
      "Query perf plan lacks finite execution time and shared buffers",
    );
  }
  // Root buffer counters include child work; summing the tree counts it twice.
  return { sharedBlocks: hit + read, executionTimeMs: time };
};

/** A measurement against its absolute budget; no earlier recording takes part. */
export const budgetViolations = (
  measured: QueryPerfMetrics,
  budgetPages: number,
) => {
  const violations: {
    kind: "shared-buffer-budget" | "execution-time-hang-guard";
    message: string;
  }[] = [];
  if (measured.sharedBlocks > budgetPages) {
    violations.push({
      kind: "shared-buffer-budget",
      message: `shared buffer budget exceeded: measured ${measured.sharedBlocks} > budget ${budgetPages}`,
    });
  }
  if (measured.executionTimeMs > QUERY_PERF_HANG_GUARD_MS) {
    violations.push({
      kind: "execution-time-hang-guard",
      message: `execution time hang guard exceeded: ${measured.executionTimeMs} ms > ${QUERY_PERF_HANG_GUARD_MS} ms`,
    });
  }
  return violations;
};

/**
 * Why a measurement breaks its budget, if it does. An entry marked over
 * budget must stay over it: once a change brings it under, the marker has to
 * go, so the budget is enforced again.
 */
const pageBudgetProblem = (
  id: ReadBudgetId,
  sharedBlocks: number,
): string | undefined => {
  const budget = READ_BUDGETS[id];
  const over = sharedBlocks > budget.pages;
  if ("overBudget" in budget) {
    return over
      ? undefined
      : `${id} is marked over budget but measured ${String(sharedBlocks)} <= ${String(budget.pages)}; remove its overBudget marker`;
  }
  return over
    ? `${id}: ${String(sharedBlocks)} pages > budget ${String(budget.pages)}`
    : undefined;
};

export const budgetProblem = (id: ReadBudgetId, measured: QueryPerfMetrics) => {
  const hang = budgetViolations(measured, READ_BUDGETS[id].pages).find(
    (violation) => violation.kind === "execution-time-hang-guard",
  );
  return hang === undefined
    ? pageBudgetProblem(id, measured.sharedBlocks)
    : `${id}: ${hang.message}`;
};

/**
 * A run measured on a scenario and on its twin at twice the corpus size. The
 * twin may cost a b-tree level more, never a share of the extra rows.
 */
const SCALE_TOLERANCE = 1.1;
const SCALE_SLACK_PAGES = 64;

export const scaleViolations = ({
  size,
  double,
}: {
  size: number;
  double: number;
}) => {
  const allowed = Math.floor(size * SCALE_TOLERANCE) + SCALE_SLACK_PAGES;
  return double > allowed
    ? [
        `reads grow with the corpus: ${size} pages at one size, ${double} at twice the size (at most ${allowed})`,
      ]
    : [];
};

export const shapeViolations = (
  document: ExplainPlanDocument,
  profileId: QueryPerfTenantProfileId,
) =>
  scanOccurrences(document.Plan).flatMap((scan) => {
    if (scan.relation !== "search_documents") {
      return [];
    }
    const violations: string[] = [];
    if (profileId === "growth" && scan.nodeType === "Seq Scan") {
      violations.push("Seq Scan on search_documents");
    }
    if (/\bSubPlan\b/u.test(withoutAuthorizationSubplans(scan))) {
      violations.push("per-row policy subplan on search_documents");
    }
    return violations;
  });

type MeasureQueryPerfOptions = {
  database: GatedTestDb;
  seed: Awaited<ReturnType<typeof seedQueryPerf>>;
  query: SQLWrapper;
  owner: string;
  ownerDeadlineMs: number | undefined;
  profileId: QueryPerfProfileId;
};

const statementText = (query: SQLWrapper) =>
  new PgDialect()
    .sqlToQuery(query.getSQL())
    .sql.replaceAll(/\s+/gu, " ")
    .trim();

export const summarize = (
  samples: readonly QueryPerfMetrics[],
  plans: readonly ExplainPlanDocument[],
  owner: string,
  ownerDeadlineMs: number | undefined,
  statement: string,
  profileId: QueryPerfProfileId,
) => {
  const lastPlan = plans.at(-1);
  if (lastPlan === undefined) {
    return panic("Query perf did not measure a plan");
  }
  return {
    metrics: {
      sharedBlocks: Math.max(
        ...samples.map(({ sharedBlocks }) => sharedBlocks),
      ),
      executionTimeMs: median(
        samples.map(({ executionTimeMs }) => executionTimeMs),
      ),
    },
    plan: lastPlan,
    planViolations: plans.flatMap((document) =>
      analyzePlan({ document, owner, ownerDeadlineMs, statement, profileId }),
    ),
    samples,
  };
};

/** One tenant statement as `stella` under row security. */
export const measureQueryPerf = async ({
  database,
  seed,
  query,
  owner,
  ownerDeadlineMs,
  profileId,
}: MeasureQueryPerfOptions) => {
  const samples: QueryPerfMetrics[] = [];
  const plans: ExplainPlanDocument[] = [];
  for (let sample = 0; sample <= QUERY_PERF_REPETITIONS; sample++) {
    // db-await-in-loop: five sequential warm-cache measurements plus one discarded warmup; concurrency would distort the benchmark.
    const documents = await explainAsStella({
      database: {
        transaction: async (fn) =>
          await database.transaction(async (tx) => {
            await applyPlannerSettings(tx);
            const value = await fn(tx);
            await assertPlannerSettings(tx);
            return value;
          }),
      },
      organizationId: seed.context.organizationId,
      userId: seed.context.userId,
      workspaceScope: seed.context.workspaceScope,
      featureIds: seed.context.featureIds,
      jit: QUERY_PERF_JIT(),
      query,
    });
    const document = documents.at(0);
    if (document === undefined || documents.length !== 1) {
      return panic("Query perf requires one plan document");
    }
    plans.push(document);
    if (sample !== 0) {
      samples.push(metricsFromPlan(document));
    }
  }
  return summarize(
    samples,
    plans,
    owner,
    ownerDeadlineMs,
    statementText(query),
    profileId,
  );
};

const isExplainPlanDocument = (
  document: unknown,
): document is ExplainPlanDocument =>
  isRecord(document) && isRecord(document["Plan"]);

/** Analyzes one statement inside `tx`, which already holds the planner settings. */
export const explainOwnerStatement = async (
  tx: TransactionOf<GatedTestDb>,
  query: SQLWrapper,
): Promise<ExplainPlanDocument> => {
  const row = executedRows(
    await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`),
  ).at(0);
  const plan: unknown = isRecord(row) ? row["QUERY PLAN"] : undefined;
  if (
    !Array.isArray(plan) ||
    plan.length !== 1 ||
    !plan.every(isExplainPlanDocument)
  ) {
    return panic("Could not decode EXPLAIN JSON plan");
  }
  return plan.at(0) ?? panic("Could not decode EXPLAIN JSON plan");
};

/**
 * One public corpus statement as the fixture's owner, the role scheduled
 * jobs run as. `build` receives the measuring transaction because statement
 * builders take the reader's transaction handle.
 */
export const measureOwnerStatement = async ({
  database,
  build,
  owner,
  ownerDeadlineMs,
  profileId,
}: {
  database: GatedTestDb;
  build: (tx: TransactionOf<GatedTestDb>) => SQLWrapper;
  owner: string;
  ownerDeadlineMs: number | undefined;
  profileId: QueryPerfProfileId;
}) => {
  const samples: QueryPerfMetrics[] = [];
  const plans: ExplainPlanDocument[] = [];
  let lastStatement = "";
  for (let sample = 0; sample <= QUERY_PERF_REPETITIONS; sample++) {
    // db-await-in-loop: sequential warm-cache measurements plus one discarded warmup; concurrency would distort the benchmark.
    const { document, statement } = await database.transaction(async (tx) => {
      await applyPlannerSettings(tx);
      const query = build(tx);
      const explained = await explainOwnerStatement(tx, query);
      await assertPlannerSettings(tx, "owner");
      return { document: explained, statement: statementText(query) };
    });
    plans.push(document);
    lastStatement = statement;
    if (sample !== 0) {
      samples.push(metricsFromPlan(document));
    }
  }
  return summarize(
    samples,
    plans,
    owner,
    ownerDeadlineMs,
    lastStatement,
    profileId,
  );
};
