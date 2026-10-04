import type { SystemRunActor } from "@/api/lib/system-audit/actors";

import { jsonb, p, sql, stella, timestamptz } from "./common";

const OWNER_ONLY = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.system_audit_runs'::regclass)`;

/**
 * The audit trail of work no member performed and no organization owns:
 * public corpus maintenance, retention sweeps and other scheduler runs. One
 * row per run that changed something, with counts, never one row per touched
 * record. `audit_logs` cannot hold these, because its rows belong to an
 * organization.
 *
 * Append-only: no role may update a row. The application role may only
 * insert; the table owner reads, and deletes rows past retention through
 * the `audit.purgeSystemRuns` scheduler task.
 */
export const systemAuditRuns = p.pgTable.withRLS(
  "system_audit_runs",
  {
    id: p.uuid().primaryKey(),
    /**
     * The CHECK pins the shape; the column type pins the declared set, so an
     * insert of an undeclared actor does not compile. Listing the set in the
     * CHECK would put a migration on every new actor.
     */
    actor: p.text().$type<SystemRunActor>().notNull(),
    /** The scheduler run that made the change. Ids only, never content. */
    subject: p.text().notNull(),
    /** What the run changed, keyed by the counts its actor declares. */
    counts: jsonb().$type<Record<string, number>>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.check(
      "system_audit_runs_actor_check",
      sql`${table.actor} ~ '^system:[a-z][a-z0-9-]*$'`,
    ),
    p.check(
      "system_audit_runs_subject_check",
      sql`char_length(${table.subject}) BETWEEN 1 AND 128`,
    ),
    p.check(
      "system_audit_runs_counts_check",
      sql`jsonb_typeof(${table.counts}) = 'object'`,
    ),
    // Serves the retention purge, the table's only read.
    p.index("system_audit_runs_created_at_idx").on(table.createdAt),
    p.pgPolicy("system_audit_runs_owner_access", {
      for: "all",
      to: "public",
      using: OWNER_ONLY,
      withCheck: OWNER_ONLY,
    }),
    p.pgPolicy("system_audit_runs_stella_insert", {
      for: "insert",
      to: stella,
      withCheck: sql`true`,
    }),
    p.pgPolicy("system_audit_runs_no_update", {
      as: "restrictive",
      for: "update",
      to: "public",
      using: sql`false`,
    }),
    p.pgPolicy("system_audit_runs_no_stella_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);
