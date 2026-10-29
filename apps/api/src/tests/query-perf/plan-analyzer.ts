import { isRecord } from "@/api/lib/type-guards";
import type { ExplainPlanDocument } from "@/api/tests/explain-as-stella";

import { isExceptedPlanViolation } from "./plan-exceptions";
import { isLargeQueryPerfRelation } from "./table-sizes";

/** Fixture rows represent one percent of the production-shape population. */
export const QUERY_PERF_FIXTURE_SCALE_FACTOR = 100;
/**
 * PostgreSQL's outer statement bound. A private check pins this value to the
 * infrastructure setting; measured owners must use their own tighter bound.
 */
export const SERVER_STATEMENT_TIMEOUT_MS = 300_000;
/** A single statement may consume at most one quarter of its owner's deadline. */
export const QUERY_PERF_TIMEOUT_SHARE = 1 / 4;
export const NESTED_LOOP_OUTER_ROW_LIMIT = 1000;

export type PlanViolation = {
  kind:
    | "deadline-missing"
    | "large-scan"
    | "unbounded-nested-loop"
    | "spill"
    | "scaled-time";
  owner: string;
  statement: string;
  node: Record<string, unknown>;
  message: string;
};

const children = (node: Record<string, unknown>) => {
  const plans = node["Plans"];
  return Array.isArray(plans) ? plans.filter(isRecord) : [];
};

const hasBound = (node: Record<string, unknown>): boolean => {
  if (node["Node Type"] === "Limit" || typeof node["Index Cond"] === "string") {
    return true;
  }
  return children(node).some(hasBound);
};

const nodeLabel = (node: Record<string, unknown>) => {
  const nodeType = node["Node Type"];
  const relation = node["Relation Name"];
  return `${typeof nodeType === "string" ? nodeType : "unknown node"}${typeof relation === "string" ? ` on ${relation}` : ""}`;
};

export const analyzePlan = ({
  document,
  owner,
  ownerDeadlineMs,
  statement,
}: {
  document: ExplainPlanDocument;
  owner: string;
  ownerDeadlineMs: number | undefined;
  statement: string;
}): PlanViolation[] => {
  const violations: PlanViolation[] = [];
  const report = (
    kind: PlanViolation["kind"],
    node: Record<string, unknown>,
    detail: string,
  ) => {
    violations.push({
      kind,
      owner,
      statement,
      node,
      message: `${owner}: ${detail}; statement: ${statement}; node: ${nodeLabel(node)}`,
    });
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
    if (
      typeof relation === "string" &&
      isLargeQueryPerfRelation(relation) &&
      (nodeType === "Seq Scan" ||
        (nodeType === "Bitmap Heap Scan" &&
          typeof discarded === "number" &&
          discarded > 0))
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
        !hasBound(outer)
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
    if (
      (nodeType === "Sort" &&
        typeof sortMethod === "string" &&
        sortMethod.toLowerCase().startsWith("external")) ||
      (nodeType === "Hash" &&
        typeof hashBatches === "number" &&
        hashBatches > 1)
    ) {
      report("spill", node, "sort or hash spilled to disk");
    }
    for (const child of children(node)) {
      visit(child);
    }
  };
  visit(document.Plan);
  const executionTime = document["Execution Time"];
  const allowance =
    ownerDeadlineMs === undefined
      ? undefined
      : ownerDeadlineMs * QUERY_PERF_TIMEOUT_SHARE;
  if (
    allowance !== undefined &&
    typeof executionTime === "number" &&
    executionTime * QUERY_PERF_FIXTURE_SCALE_FACTOR > allowance
  ) {
    report(
      "scaled-time",
      document.Plan,
      `scaled execution time ${String(executionTime * QUERY_PERF_FIXTURE_SCALE_FACTOR)} ms exceeds ${String(allowance)} ms`,
    );
  }
  return violations.filter((violation) => !isExceptedPlanViolation(violation));
};
