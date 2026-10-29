import type { PlanViolation } from "./plan-analyzer";

/** Existing plan debt only. Remove entries when their owning access path changes. */
export const PLAN_EXCEPTIONS = [
  {
    owner: "statement.documents.searchHits",
    profileId: "small",
    kind: "deadline-missing",
    reason:
      "The tenant search request currently relies on the server statement bound.",
  },
  {
    owner: "statement.documents.searchHits",
    profileId: "growth",
    kind: "deadline-missing",
    reason:
      "The tenant search request currently relies on the server statement bound.",
  },
  {
    owner: "caseLaw.reportFreshness.fiveMinute",
    profileId: "corpus",
    kind: "deadline-missing",
    reason:
      "The scheduled report currently relies on the server statement bound.",
  },
  {
    owner: "statement.documents.searchHits",
    profileId: "small",
    kind: "large-scan",
    relation: "member",
    reason: "The RLS membership CTE scans the single seeded membership row.",
  },
  {
    owner: "statement.documents.searchHits",
    profileId: "growth",
    kind: "large-scan",
    relation: "member",
    reason: "The RLS membership CTE scans the single seeded membership row.",
  },
  {
    owner: "statement.documents.searchHits",
    profileId: "small",
    kind: "large-scan",
    relation: "workspaces",
    reason: "The RLS workspace branches scan the two-row fixture relation.",
  },
  {
    owner: "statement.documents.searchHits",
    profileId: "growth",
    kind: "large-scan",
    relation: "workspaces",
    reason: "The RLS workspace branches scan the two-row fixture relation.",
  },
  {
    owner: "statement.documents.searchHits",
    profileId: "small",
    kind: "large-scan",
    relation: "workspace_members",
    reason: "The RLS membership branch scans the single seeded membership row.",
  },
  {
    owner: "statement.documents.searchHits",
    profileId: "growth",
    kind: "large-scan",
    relation: "workspace_members",
    reason: "The RLS membership branch scans the single seeded membership row.",
  },
  {
    owner: "statement.documents.searchHits",
    profileId: "small",
    kind: "large-scan",
    relation: "search_documents",
    reason:
      "The small tenant profile retains its existing sequential search plan.",
  },
  {
    owner: "statement.documents.searchHits",
    profileId: "small",
    kind: "large-scan",
    relation: "entities",
    reason:
      "An RLS authorization branch retains its existing sequential entity plan.",
  },
  {
    owner: "statement.documents.searchHits",
    profileId: "small",
    kind: "large-scan",
    relation: "entity_versions",
    reason:
      "The small tenant profile retains its existing sequential version plan.",
  },
] as const satisfies readonly {
  owner: string;
  profileId: PlanViolation["profileId"];
  kind: PlanViolation["kind"];
  relation?: string;
  reason: string;
}[];

export const isExceptedPlanViolation = (violation: PlanViolation) =>
  PLAN_EXCEPTIONS.some(
    (entry) =>
      entry.owner === violation.owner &&
      entry.profileId === violation.profileId &&
      entry.kind === violation.kind &&
      (!("relation" in entry) ||
        entry.relation === violation.node["Relation Name"]),
  );
