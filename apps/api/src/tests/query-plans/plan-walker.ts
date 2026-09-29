import { panic } from "better-result";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

import { PLAN_GUARD_TABLES } from "../../db/plan-guard-tables";

type PlanNode = Record<string, unknown>;

export type ScanOccurrence = {
  position: string;
  alias: string | null;
  relation: string;
  nodeType: string;
  index: string | null;
  indexCond: string | null;
  filter: string | null;
  rows: number | null;
  /** A Limit stops this scan early; see `childLimitBound` for what counts. */
  limitAbove: boolean;
  /** The tightest bounding Limit's estimated rows, when it has one. */
  limitRows: number | null;
  subplans: readonly {
    position: string;
    name: string | null;
    relations: readonly string[];
  }[];
};

export type AccessPath = Pick<
  ScanOccurrence,
  "relation" | "nodeType" | "index"
> &
  (
    | { position: string; alias?: never; occurrence?: never }
    | { alias: string; position?: never; occurrence?: never }
    | { occurrence: number; position?: never; alias?: never }
  );

export type HeapFetchMitigation =
  | { type: "batched"; pageSize: number }
  | { type: "snapshot"; relation: string }
  | { type: "heapFetchBudget"; rows: number; reason: string };

const guardedTables = new Set<string>(PLAN_GUARD_TABLES);

const field = (node: PlanNode, name: string): string | null => {
  const value = node[name];
  return typeof value === "string" ? value : null;
};

const childPlans = (node: PlanNode): readonly PlanNode[] => {
  const plans = node["Plans"];
  if (plans === undefined) {
    return [];
  }
  if (!isUnknownArray(plans) || !plans.every(isRecord)) {
    return panic("EXPLAIN plan has malformed children");
  }
  return plans;
};

const descendants = (node: PlanNode): PlanNode[] => {
  const found: PlanNode[] = [];
  for (const child of childPlans(node)) {
    found.push(child, ...descendants(child));
  }
  return found;
};

const attachedDescendants = (node: PlanNode): PlanNode[] => {
  const found: PlanNode[] = [];
  for (const child of childPlans(node)) {
    const relationship = field(child, "Parent Relationship");
    if (relationship === "SubPlan" || relationship === "InitPlan") {
      continue;
    }
    found.push(child, ...attachedDescendants(child));
  }
  return found;
};

const subplansOf = (node: PlanNode, position: string) => {
  const found: ScanOccurrence["subplans"][number][] = [];
  const visit = (parent: PlanNode, path: string) => {
    for (const [index, child] of childPlans(parent).entries()) {
      const childPosition = `${path}/${index}`;
      if (field(child, "Parent Relationship") === "SubPlan") {
        const relations = [child, ...descendants(child)].flatMap((candidate) =>
          [field(candidate, "Relation Name"), field(candidate, "Alias")].filter(
            (value): value is string => value !== null,
          ),
        );
        found.push({
          position: childPosition,
          name: field(child, "Subplan Name"),
          relations,
        });
      }
      visit(child, childPosition);
    }
  };
  visit(node, position);
  return found;
};

const indexDetails = (node: PlanNode) => {
  const candidates =
    field(node, "Node Type") === "Bitmap Heap Scan"
      ? attachedDescendants(node).filter(
          (candidate) => field(candidate, "Node Type") === "Bitmap Index Scan",
        )
      : [node];
  const indexNodes = candidates.filter((candidate) => {
    const nodeType = field(candidate, "Node Type");
    return (
      nodeType === "Index Scan" ||
      nodeType === "Index Only Scan" ||
      nodeType === "Bitmap Index Scan"
    );
  });
  return {
    index:
      indexNodes
        .flatMap((candidate) => {
          const name = field(candidate, "Index Name");
          return name === null ? [] : [name];
        })
        .join(", ") || null,
    indexCond:
      indexNodes
        .flatMap((candidate) => {
          const condition = field(candidate, "Index Cond");
          return condition === null ? [] : [condition];
        })
        .join(" AND ") || null,
  };
};

/** Decode Drizzle/PGlite's single JSON EXPLAIN row; malformed plans fail closed. */
export const explainRoot = (explained: unknown): PlanNode => {
  const rows = isRecord(explained) ? explained["rows"] : explained;
  if (!isUnknownArray(rows) || rows.length !== 1) {
    return panic("EXPLAIN did not return one JSON plan row");
  }
  const row = rows[0];
  const documents = isRecord(row) ? row["QUERY PLAN"] : undefined;
  if (!isUnknownArray(documents) || documents.length !== 1) {
    return panic("EXPLAIN row has no single JSON plan");
  }
  const document = documents[0];
  if (!isRecord(document) || !isRecord(document["Plan"])) {
    return panic("EXPLAIN JSON has no root plan");
  }
  return document["Plan"];
};

/** `null`: nothing stops the node early. `rows: null`: a Limit without an estimate. */
type LimitBound = { rows: number | null } | null;

const tighterBound = (bound: LimitBound, node: PlanNode): LimitBound => {
  const planRows = node["Plan Rows"];
  const rows = typeof planRows === "number" ? planRows : null;
  if (bound === null || bound.rows === null) {
    return { rows };
  }
  return { rows: rows === null ? bound.rows : Math.min(bound.rows, rows) };
};

/**
 * Only nodes that emit at least one row per input row, and pull input lazily,
 * pass an enclosing Limit to a child. Everything else counts as blocking:
 * aggregates, sorts, hashes, materialization, windowing, set operations,
 * Unique, ProjectSet (an empty set drops its input row), merge joins, and
 * the inner side of any join, which reruns per outer row. SubPlans and
 * InitPlans run separately, so an outer Limit bounds how often they run,
 * never what they read. A Filter discards rows it has already read, so a
 * node with one bounds nothing below it; EXPLAIN only estimates how many.
 */
const childLimitBound = (
  node: PlanNode,
  child: PlanNode,
  bound: LimitBound,
): LimitBound => {
  const relationship = field(child, "Parent Relationship");
  if (relationship === "SubPlan" || relationship === "InitPlan") {
    return null;
  }
  const nodeType = field(node, "Node Type");
  if (nodeType === "Limit") {
    return tighterBound(bound, node);
  }
  if (bound === null || field(node, "Filter") !== null) {
    return null;
  }
  switch (nodeType) {
    case "Result":
    case "Subquery Scan":
    case "Append":
    case "Merge Append":
    case "Gather":
    case "Gather Merge":
      return bound;
    case "Nested Loop":
    case "Hash Join":
      // A left join keeps every outer row, so the outer side streams to the Limit.
      return field(node, "Join Type") === "Left" && relationship === "Outer"
        ? bound
        : null;
    default:
      return null;
  }
};

/** Each physical relation scan keeps its structural path, including UNION arms. */
export const scanOccurrences = (root: PlanNode): ScanOccurrence[] => {
  const scans: ScanOccurrence[] = [];
  const visit = (node: PlanNode, position: string, bound: LimitBound) => {
    const relation = field(node, "Relation Name");
    const nodeType = field(node, "Node Type");
    const filter = field(node, "Filter");
    if (relation !== null && nodeType?.includes("Scan")) {
      const { index, indexCond } = indexDetails(node);
      const rows = node["Plan Rows"];
      // A filtered scan reads past the rows the Limit counts.
      const scanBound = filter === null ? bound : null;
      scans.push({
        position,
        alias: field(node, "Alias"),
        relation,
        nodeType,
        index,
        indexCond,
        filter,
        rows: typeof rows === "number" ? rows : null,
        limitAbove: scanBound !== null,
        limitRows: scanBound?.rows ?? null,
        subplans: subplansOf(node, position),
      });
    }
    for (const [index, child] of childPlans(node).entries()) {
      visit(child, `${position}/${index}`, childLimitBound(node, child, bound));
    }
  };
  visit(root, "root", null);
  return scans;
};

/** Unbounded covering scans can visit heap pages when visibility bits are clear. */
export const heapFetchRiskViolations = (
  scans: readonly ScanOccurrence[],
  scanClass: "point" | "page" | "aggregate",
  mitigation?: HeapFetchMitigation,
): string[] => {
  const coveringScans = scans.filter(
    ({ relation, nodeType }) =>
      guardedTables.has(relation) &&
      nodeType === "Index Only Scan" &&
      scanClass !== "point",
  );
  const riskyScans = coveringScans.filter(({ limitAbove }) => !limitAbove);
  if (mitigation === undefined) {
    return riskyScans.map(
      ({ position, relation }) =>
        `${position}: heap-fetch risk on ${relation}: declare one mitigation`,
    );
  }
  switch (mitigation.type) {
    case "batched": {
      const { pageSize } = mitigation;
      if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
        return ["batched heap-fetch mitigation needs a positive page size"];
      }
      // The declared page size only counts when the observed plan enforces it.
      return coveringScans.flatMap(({ position, relation, limitRows }) => {
        if (limitRows === null) {
          return [
            `${position}: batched mitigation but no observed LIMIT bounds ${relation}`,
          ];
        }
        return limitRows > pageSize
          ? [
              `${position}: LIMIT of ${String(limitRows)} rows exceeds the batched page size ${String(pageSize)} on ${relation}`,
            ]
          : [];
      });
    }
    case "snapshot":
      if (!scans.some(({ relation }) => relation === mitigation.relation)) {
        return [
          `snapshot heap-fetch mitigation does not read ${mitigation.relation}`,
        ];
      }
      return riskyScans.map(
        ({ position, relation }) =>
          `${position}: snapshot mitigation does not cover ${relation}`,
      );
    case "heapFetchBudget":
      return Number.isFinite(mitigation.rows) &&
        mitigation.rows >= 0 &&
        mitigation.reason.trim().length > 0
        ? []
        : ["heap-fetch budget needs a nonnegative number and a reason"];
  }
};

/** The workspace access view appears as `aw` over its base tables in EXPLAIN. */
export const withoutAuthorizationSubplans = (scan: ScanOccurrence): string => {
  let filter = scan.filter ?? "";
  for (const subplan of scan.subplans) {
    if (
      subplan.name !== null &&
      subplan.relations.includes("aw") &&
      subplan.relations.includes("workspace_members") &&
      subplan.relations.includes("workspaces")
    ) {
      const escapedName = subplan.name.replaceAll(
        /[.*+?^${}()|[\]\\]/gu,
        "\\$&",
      );
      filter = filter.replaceAll(new RegExp(`${escapedName}(?!\\d)`, "gu"), "");
    }
  }
  return filter;
};

const hasSubplan = (filter: string): boolean =>
  /\b(?:SubPlan|EXISTS)\b/iu.test(filter);

/** Postgres parenthesizes boolean groups in Filter text. Check each OR group. */
const hasOrSubplan = (filter: string): boolean => {
  const arms: string[] = [];
  const groups: string[] = [];
  let depth = 0;
  let armStart = 0;
  let groupStart = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < filter.length; index += 1) {
    const char = filter[index];
    if (char === quote) {
      if (filter[index + 1] === quote) {
        index += 1;
      } else {
        quote = null;
      }
      continue;
    }
    if (quote !== null) {
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      if (depth === 0) {
        groupStart = index + 1;
      }
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        groups.push(filter.slice(groupStart, index));
      }
      continue;
    }
    if (
      depth === 0 &&
      filter.slice(index, index + 2).toUpperCase() === "OR" &&
      !/[A-Za-z0-9_]/u.test(filter[index - 1] ?? "") &&
      !/[A-Za-z0-9_]/u.test(filter[index + 2] ?? "")
    ) {
      arms.push(filter.slice(armStart, index));
      armStart = index + 2;
      index += 1;
    }
  }
  if (arms.length > 0) {
    arms.push(filter.slice(armStart));
    if (arms.some(hasSubplan)) {
      return true;
    }
  }
  return groups.some(hasOrSubplan);
};

/** Return violations for guarded scans; rows remain available for reporting. */
export const accessPathViolations = (
  scans: readonly ScanOccurrence[],
  expected: readonly AccessPath[],
  scanClass: "point" | "page" | "aggregate",
  allowAggregateSeqScan: boolean,
): string[] => {
  const violations: string[] = [];
  const actualGuarded = scans.filter((scan) =>
    guardedTables.has(scan.relation),
  );
  const matches = (scan: ScanOccurrence, path: AccessPath): boolean => {
    if (path.position !== undefined) {
      return scan.position === path.position;
    }
    if (path.alias !== undefined) {
      return scan.alias === path.alias;
    }
    // The occurrence is the relation's zero-based DFS position in this plan.
    return (
      scan.relation === path.relation &&
      actualGuarded
        .filter((candidate) => candidate.relation === scan.relation)
        .indexOf(scan) === path.occurrence
    );
  };
  for (const scan of actualGuarded) {
    const targets = expected.filter((path) => matches(scan, path));
    const target = targets.at(0);
    if (target === undefined || targets.length !== 1) {
      violations.push(`${scan.position}: uncontracted ${scan.relation} scan`);
    } else if (
      target.relation !== scan.relation ||
      target.nodeType !== scan.nodeType ||
      target.index !== scan.index
    ) {
      violations.push(
        `${scan.position}: expected ${target.nodeType}/${target.index ?? "none"}, got ${scan.nodeType}/${scan.index ?? "none"} on ${scan.relation}`,
      );
    }
    if (
      scan.nodeType === "Seq Scan" &&
      !(scanClass === "aggregate" && allowAggregateSeqScan)
    ) {
      violations.push(`${scan.position}: Seq Scan on ${scan.relation}`);
    }
    if (scan.filter !== null) {
      const filter = withoutAuthorizationSubplans(scan);
      if (hasOrSubplan(filter)) {
        violations.push(`${scan.position}: OR with a subplan`);
      }
      if (hasSubplan(filter) && scan.indexCond === null) {
        violations.push(
          `${scan.position}: residual subplan without index condition`,
        );
      }
    }
  }
  for (const path of expected) {
    const matching = actualGuarded.filter((scan) => matches(scan, path));
    if (matching.length !== 1) {
      const locator =
        path.position ??
        path.alias ??
        `${path.relation}[${path.occurrence === undefined ? "missing" : String(path.occurrence)}]`;
      violations.push(
        `${locator}: expected one ${path.relation} scan, found ${matching.length}`,
      );
    }
  }
  return violations;
};
