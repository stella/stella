import type { PlanViolation } from "./plan-analyzer";

/** Existing plan debt only. Remove entries when their owning access path changes. */
export const PLAN_EXCEPTIONS = [
  {
    owner: "statement.documents.searchHits",
    kind: "large-scan",
    relation: "member",
    reason: "The RLS membership CTE scans the single seeded membership row.",
  },
  {
    owner: "statement.documents.searchHits",
    kind: "large-scan",
    relation: "workspaces",
    reason: "The RLS workspace branches scan the two-row fixture relation.",
  },
  {
    owner: "statement.documents.searchHits",
    kind: "large-scan",
    relation: "workspace_members",
    reason: "The RLS membership branch scans the single seeded membership row.",
  },
  {
    owner: "statement.documents.searchHits",
    kind: "large-scan",
    relation: "search_documents",
    reason:
      "The small tenant profile retains its existing sequential search plan.",
  },
  {
    owner: "statement.documents.searchHits",
    kind: "large-scan",
    relation: "entities",
    reason:
      "An RLS authorization branch retains its existing sequential entity plan.",
  },
  {
    owner: "statement.documents.searchHits",
    kind: "large-scan",
    relation: "entity_versions",
    reason:
      "The small tenant profile retains its existing sequential version plan.",
  },
] as const satisfies readonly {
  owner: string;
  kind: PlanViolation["kind"];
  relation: string;
  reason: string;
}[];

export const isExceptedPlanViolation = (violation: PlanViolation) =>
  PLAN_EXCEPTIONS.some(
    (entry) =>
      entry.owner === violation.owner &&
      entry.kind === violation.kind &&
      entry.relation === violation.node["Relation Name"],
  );
