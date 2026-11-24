import { panic } from "better-result";

import { PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT } from "@/api/lib/public-law-relations";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import type { ExplainPlanDocument } from "@/api/tests/explain-as-stella";

import { isExceptedPlanViolation } from "./plan-exceptions";
import type { QueryPerfProfileId } from "./profiles";
import { median } from "./sampling";
import { isLargeQueryPerfRelation } from "./table-sizes";

/** Fixture rows represent one percent of the production-shape population. */
const QUERY_PERF_FIXTURE_SCALE_FACTOR = 100;
/**
 * PostgreSQL's outer statement bound. A private check pins this value to the
 * infrastructure setting; measured owners must use their own tighter bound.
 */
export const SERVER_STATEMENT_TIMEOUT_MS = 300_000;
/** A single statement may consume at most one quarter of its owner's deadline. */
const QUERY_PERF_TIMEOUT_SHARE = 1 / 4;
const NESTED_LOOP_OUTER_ROW_LIMIT = 1000;

export type PlanViolation = {
  kind:
    | "deadline-missing"
    | "large-scan"
    | "unbounded-nested-loop"
    | "spill"
    | "scaled-time";
  owner: string;
  profileId: QueryPerfProfileId;
  statement: string;
  node: Record<string, unknown>;
  message: string;
};

const nodeLabel = (node: Record<string, unknown>) => {
  const nodeType = node["Node Type"];
  const relation = node["Relation Name"];
  return `${typeof nodeType === "string" ? nodeType : "unknown node"}${typeof relation === "string" ? ` on ${relation}` : ""}`;
};

type PlanViolationSubject = Pick<
  PlanViolation,
  "owner" | "profileId" | "statement"
>;

const planViolation = (
  { owner, profileId, statement }: PlanViolationSubject,
  kind: PlanViolation["kind"],
  node: Record<string, unknown>,
  detail: string,
): PlanViolation => ({
  kind,
  owner,
  profileId,
  statement,
  node,
  message: `${owner}: ${detail}; statement: ${statement}; node: ${nodeLabel(node)}`,
});

const scaledTimeAllowanceMs = (ownerDeadlineMs: number | undefined) =>
  ownerDeadlineMs === undefined
    ? undefined
    : ownerDeadlineMs * QUERY_PERF_TIMEOUT_SHARE;

/** Whether one execution time, scaled to production, exceeds the owner's statement share. */
export const exceedsScaledTimeAllowance = (
  executionTimeMs: number,
  ownerDeadlineMs: number | undefined,
) => {
  const allowance = scaledTimeAllowanceMs(ownerDeadlineMs);
  return (
    allowance !== undefined &&
    executionTimeMs * QUERY_PERF_FIXTURE_SCALE_FACTOR > allowance
  );
};

/**
 * The scaled-time finding for one statement, decided by the median of its
 * execution-time samples rather than by any single one of them.
 */
export const scaledTimeViolations = ({
  document,
  executionTimesMs,
  ...subject
}: PlanViolationSubject & {
  document: ExplainPlanDocument;
  executionTimesMs: readonly number[];
  ownerDeadlineMs: number | undefined;
}): PlanViolation[] => {
  const allowance = scaledTimeAllowanceMs(subject.ownerDeadlineMs);
  const executionTime = median(executionTimesMs);
  if (
    allowance === undefined ||
    !exceedsScaledTimeAllowance(executionTime, subject.ownerDeadlineMs)
  ) {
    return [];
  }
  const scaled = executionTime * QUERY_PERF_FIXTURE_SCALE_FACTOR;
  return [
    planViolation(
      subject,
      "scaled-time",
      document.Plan,
      `scaled execution time ${String(scaled)} ms (median of ${String(executionTimesMs.length)} samples) exceeds ${String(allowance)} ms`,
    ),
  ].filter((violation) => !isExceptedPlanViolation(violation));
};

const children = (node: Record<string, unknown>) => {
  const plans = node["Plans"];
  return Array.isArray(plans) ? plans.filter(isRecord) : [];
};

const rowCounter = (node: Record<string, unknown>, name: string) => {
  const value = node[name] ?? 0;
  return typeof value === "number"
    ? value
    : panic(`Plan node ${name} is not a number`);
};

/** Rows returned or rejected by every scan of a relation, over all its loops. */
export const relationRowsVisited = (
  node: Record<string, unknown>,
  relation: string,
): number => {
  const own =
    node["Relation Name"] === relation
      ? (rowCounter(node, "Actual Rows") +
          rowCounter(node, "Rows Removed by Filter") +
          rowCounter(node, "Rows Removed by Index Recheck")) *
        rowCounter(node, "Actual Loops")
      : 0;
  const plans = node["Plans"] ?? [];
  if (!isUnknownArray(plans) || !plans.every(isRecord)) {
    return panic("Plan children are malformed");
  }
  return plans.reduce(
    (sum, child) => sum + relationRowsVisited(child, relation),
    own,
  );
};

const hasOuterStreamBound = (node: Record<string, unknown>): boolean => {
  if (node["Node Type"] === "Limit" || typeof node["Index Cond"] === "string") {
    return true;
  }
  const plans = children(node);
  const child = plans.at(0);
  return (
    plans.length === 1 && child !== undefined && hasOuterStreamBound(child)
  );
};

// The folded queue is deliberately empty in this job profile. PostgreSQL
// chooses a zero-buffer sequential scan there; its nonempty maximum window
// is measured separately, without relaxing classification of queue storage.
const isEmptyPopulationDeltaScan = (
  node: Record<string, unknown>,
  owner: string,
) =>
  owner === SCHEDULER_BACKFILL_IDS.coverage &&
  node["Node Type"] === "Seq Scan" &&
  node["Relation Name"] ===
    PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT.caseLawPopulationDeltas &&
  ["Actual Rows", "Shared Hit Blocks", "Shared Read Blocks"].every(
    (field) => node[field] === 0,
  ) &&
  (node["Rows Removed by Filter"] ?? 0) === 0;

export const analyzePlan = ({
  document,
  owner,
  ownerDeadlineMs,
  profileId,
  statement,
}: {
  document: ExplainPlanDocument;
  owner: string;
  ownerDeadlineMs: number | undefined;
  profileId: QueryPerfProfileId;
  statement: string;
}): PlanViolation[] => {
  const violations: PlanViolation[] = [];
  const report = (
    kind: PlanViolation["kind"],
    node: Record<string, unknown>,
    detail: string,
  ) => {
    violations.push(
      planViolation({ owner, profileId, statement }, kind, node, detail),
    );
  };
  if (ownerDeadlineMs === undefined) {
    report(
      "deadline-missing",
      document.Plan,
      "owner applies no statement deadline",
    );
  }
  const visit = (node: Record<string, unknown>) => {
    const nodeType = node["Node Type"];
    const relation = node["Relation Name"];
    const discarded = node["Rows Removed by Index Recheck"];
    const lossyHeapBlocks = node["Lossy Heap Blocks"];
    if (
      typeof relation === "string" &&
      isLargeQueryPerfRelation(relation) &&
      !isEmptyPopulationDeltaScan(node, owner) &&
      (nodeType === "Seq Scan" ||
        (nodeType === "Bitmap Heap Scan" &&
          ((typeof discarded === "number" && discarded > 0) ||
            (typeof lossyHeapBlocks === "number" && lossyHeapBlocks > 0))))
    ) {
      report(
        "large-scan",
        node,
        `non-scaling scan (${nodeType}) on ${relation}`,
      );
    }
    if (nodeType === "Nested Loop") {
      const outer = children(node).at(0);
      const rows = outer?.["Actual Rows"] ?? outer?.["Plan Rows"];
      if (
        outer !== undefined &&
        typeof rows === "number" &&
        rows > NESTED_LOOP_OUTER_ROW_LIMIT &&
        !hasOuterStreamBound(outer)
      ) {
        report(
          "unbounded-nested-loop",
          node,
          `nested-loop outer side has ${String(rows)} rows without a limit or keyset bound`,
        );
      }
    }
    const sortMethod = node["Sort Method"];
    const hashBatches = node["Hash Batches"];
    const hashAggBatches = node["HashAgg Batches"];
    const diskUsage = node["Disk Usage"];
    if (
      (nodeType === "Sort" &&
        typeof sortMethod === "string" &&
        sortMethod.toLowerCase().startsWith("external")) ||
      (nodeType === "Hash" &&
        typeof hashBatches === "number" &&
        hashBatches > 1) ||
      (nodeType === "Aggregate" &&
        node["Strategy"] === "Hashed" &&
        ((typeof hashAggBatches === "number" && hashAggBatches > 1) ||
          (typeof diskUsage === "number" && diskUsage > 0)))
    ) {
      report("spill", node, "sort or hash spilled to disk");
    }
    for (const child of children(node)) {
      visit(child);
    }
  };
  visit(document.Plan);
  return violations.filter((violation) => !isExceptedPlanViolation(violation));
};
