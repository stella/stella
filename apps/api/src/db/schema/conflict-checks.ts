import {
  CONFLICT_CHECK_DECISIONS,
  CONFLICT_CHECK_LIMITS,
  CONFLICT_CHECK_OUTCOMES,
} from "@stll/api-contract/conflict-checks";
import type { ConflictParty } from "@stll/api-contract/conflict-checks";

import {
  organizationCheck,
  organizationManagerCheck,
  SETTING_USER_ID,
} from "@/api/db/rls";
import type { StoredConflictResults } from "@/api/lib/conflict-check/stored-results";

import {
  jsonb,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  stella,
  timestamptz,
  user,
  wsOrganizationPolicies,
} from "./common";
import { workspaces } from "./contacts";

const conflictCheckRunnerCheck = sql`run_by =
  (SELECT current_setting(
    '${sql.raw(SETTING_USER_ID)}', true
  ))`;

// A check names a prospective client before the firm has taken the matter, so
// it is not organization-wide: its author, the reviewers, and the members of
// the matter it was run for read it. The link table is matter-scoped, so the
// subquery sees only links to matters the session may open.
// sql-perf-allow: bounded by one check row; the member probe uses the member primary lookup and the link probe uses conflict_check_matters_check_uidx
const conflictCheckReadCheck = sql`(
  ${organizationCheck} AND (
    ${conflictCheckRunnerCheck}
    OR ${organizationManagerCheck}
    OR EXISTS (
      SELECT 1
      FROM public.conflict_check_matters link
      WHERE link.conflict_check_id = conflict_checks.id
        AND link.organization_id = conflict_checks.organization_id
    )
  )
)`;

const conflictCheckWriteCheck = sql`(
  ${organizationCheck} AND (
    ${conflictCheckRunnerCheck} OR ${organizationManagerCheck}
  )
)`;

const conflictCheckOwnerCheck = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.conflict_checks'::regclass)`;

const conflictCheckPolicies = () => [
  // The owner connection (organization reset and deletion) reaches every row.
  p.pgPolicy("conflict_check_owner", {
    for: "all",
    to: "public",
    using: conflictCheckOwnerCheck,
    withCheck: conflictCheckOwnerCheck,
  }),
  p.pgPolicy("conflict_check_select", {
    for: "select",
    to: stella,
    using: conflictCheckReadCheck,
  }),
  p.pgPolicy("conflict_check_insert", {
    for: "insert",
    to: stella,
    withCheck: sql`(${organizationCheck} AND ${conflictCheckRunnerCheck})`,
  }),
  p.pgPolicy("conflict_check_update", {
    for: "update",
    to: stella,
    using: conflictCheckWriteCheck,
    withCheck: conflictCheckWriteCheck,
  }),
  p.pgPolicy("conflict_check_delete", {
    for: "delete",
    to: stella,
    using: sql`(${organizationCheck} AND ${organizationManagerCheck})`,
  }),
];

/**
 * One internal conflict-of-interest check: the parties of a prospective
 * matter screened against the firm's contacts and matters, with what it
 * found, how far it looked, and a person's decision on it. A firm record
 * kept until a reviewer deletes it or the organization is deleted.
 */
export const conflictChecks = p.pgTable(
  "conflict_checks",
  {
    id: pUuid<"conflictCheck">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** What the check is for, as its author named it. */
    title: p.varchar({ length: CONFLICT_CHECK_LIMITS.titleChars }),
    /** Who ran the check; null once that account is gone. */
    runBy: p.text("run_by").references(() => user.id, { onDelete: "set null" }),
    /** The parties as submitted, the input the results answer. */
    parties: jsonb().$type<ConflictParty[]>().notNull(),
    /** Versioned snapshot of the matches. Holds no matter names and no user ids. */
    results: jsonb().$type<StoredConflictResults>().notNull(),
    /** The most severe finding when the check ran; fixed at insert. */
    outcome: p.text({ enum: CONFLICT_CHECK_OUTCOMES }).notNull(),
    /** A person's decision on the check; `pending` until one is recorded. */
    decision: p
      .text({ enum: CONFLICT_CHECK_DECISIONS })
      .notNull()
      .default("pending"),
    /** Advances with every recorded decision, so a stale one is refused. */
    decisionRevision: p.integer("decision_revision").notNull().default(0),
    decidedBy: p
      .text("decided_by")
      .references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamptz("decided_at"),
    decisionNote: p.text("decision_note"),
    /** The client's consent a waiver rests on; set only for `waived`. */
    consentReference: p.varchar("consent_reference", {
      length: CONFLICT_CHECK_LIMITS.consentReferenceChars,
    }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.unique("conflict_checks_id_org_unq").on(table.id, table.organizationId),
    p
      .index("conflict_checks_org_created_idx")
      .on(table.organizationId, table.createdAt.desc(), table.id.desc()),
    p
      .index("conflict_checks_org_run_by_created_idx")
      .on(
        table.organizationId,
        table.runBy,
        table.createdAt.desc(),
        table.id.desc(),
      ),
    p.index("conflict_checks_decided_by_idx").on(table.decidedBy),
    p.check(
      "conflict_checks_decision_revision_check",
      sql`${table.decisionRevision} >= 0`,
    ),
    p.check(
      "conflict_checks_outcome_check",
      sql`${table.outcome} IN (${sql.join(
        CONFLICT_CHECK_OUTCOMES.map((outcome) => sql`${outcome}`),
        sql`, `,
      )})`,
    ),
    p.check(
      "conflict_checks_decision_check",
      sql`${table.decision} IN (${sql.join(
        CONFLICT_CHECK_DECISIONS.map((decision) => sql`${decision}`),
        sql`, `,
      )})`,
    ),
    // A recorded decision carries when it was made; a pending one carries
    // nothing. The decider may be null only once their account is gone.
    p.check(
      "conflict_checks_decision_fields_check",
      sql`(${table.decision} = 'pending') = (${table.decidedAt} IS NULL) AND (${table.decision} <> 'pending' OR (${table.decidedBy} IS NULL AND ${table.decisionNote} IS NULL))`,
    ),
    // A waiver rests on recorded consent; nothing else carries a consent reference.
    p.check(
      "conflict_checks_waiver_consent_check",
      sql`(${table.decision} = 'waived') = (${table.consentReference} IS NOT NULL) AND (${table.decision} <> 'waived' OR ${table.decisionNote} IS NOT NULL)`,
    ),
    ...conflictCheckPolicies(),
  ],
);

/**
 * The matter a check was run for, when there is one. Deleting the matter
 * removes only this link; the check stays on the firm's record.
 */
export const conflictCheckMatters = p.pgTable(
  "conflict_check_matters",
  {
    id: pUuid<"conflictCheckMatter">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conflictCheckId: safeUuid<"conflictCheck">("conflict_check_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("conflict_check_matters_check_uidx")
      .on(table.conflictCheckId),
    p
      .index("conflict_check_matters_org_workspace_idx")
      .on(table.organizationId, table.workspaceId),
    p
      .foreignKey({
        columns: [table.conflictCheckId, table.organizationId],
        foreignColumns: [conflictChecks.id, conflictChecks.organizationId],
        name: "conflict_check_matters_check_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "conflict_check_matters_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("conflict_check_matters"),
  ],
);
