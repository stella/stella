import { panic } from "better-result";
import type { SQLWrapper } from "drizzle-orm";

import {
  explainAsStella,
  type ExplainPlanDocument,
} from "@/api/tests/explain-as-stella";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  scanOccurrences,
  withoutAuthorizationSubplans,
} from "@/api/tests/query-plans/plan-walker";

import type { QueryPerfProfileId } from "./profiles";
import type { seedQueryPerf } from "./seed";
import {
  applyPlannerSettings,
  assertPlannerSettings,
  QUERY_PERF_JIT,
} from "./settings";

export const QUERY_PERF_REPETITIONS = 5;
export const QUERY_PERF_TIME_FLOOR_MS = 10;
export type QueryPerfMetrics = {
  sharedBlocks: number;
  executionTimeMs: number;
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

export const budgetViolations = (
  measured: QueryPerfMetrics,
  baseline: QueryPerfMetrics,
) => {
  const violations: string[] = [];
  if (measured.sharedBlocks > baseline.sharedBlocks * 1.25) {
    violations.push("shared buffer budget exceeded");
  }
  if (
    measured.executionTimeMs > baseline.executionTimeMs * 2 &&
    measured.executionTimeMs > QUERY_PERF_TIME_FLOOR_MS
  ) {
    violations.push("execution time budget exceeded");
  }
  return violations;
};

export const shapeViolations = (
  document: ExplainPlanDocument,
  profileId: QueryPerfProfileId,
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
};

export const measureQueryPerf = async ({
  database,
  seed,
  query,
}: MeasureQueryPerfOptions) => {
  const samples: QueryPerfMetrics[] = [];
  let lastPlan: ExplainPlanDocument | undefined;
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
    lastPlan = document;
    if (sample !== 0) {
      samples.push(metricsFromPlan(document));
    }
  }
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
    samples,
  };
};
