import { Result } from "better-result";
import { eq, inArray, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import { stella, WORKSPACE_ACCESS_MODE } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import {
  chatThreads,
  CORRESPONDENCE_REVIEW_RESET_SETTING,
  userFiles,
  workspaces,
} from "@/api/db/schema";
import { runScopedWorkInTransaction } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  WORKSPACE_DELETION_RETAINED_STAGES,
  WORKSPACE_DELETION_RETAINED_TABLES,
} from "@/api/lib/organization-storage-teardown";
import { inOrder } from "@/api/lib/review-organization/in-order";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Organization-scoped tables the reset leaves in place, each with its reason.
 * Every other table that holds organization data is cleared: listed in
 * `REVIEW_RESET_CLEARED_TABLES` or `REVIEW_RESET_BILLING_TABLES`, or removed
 * by a cascade from one that is.
 * `reset-scope.test.ts` fails when a table is in neither.
 */
export const REVIEW_RESET_KEPT_TABLES = {
  member: "Membership: the review account stays in its organization.",
  invitation: "Membership: invitations belong to the organization's roster.",
  audit_logs: "Audit trail: append-only, and it records the reset itself.",
  organization_settings: "Organization settings, not reviewer content.",
  organization_access_states: "Organization access state, set by operators.",
  organization_configured_access: "Organization access, set by operators.",
  feature_enrolments:
    "The account's own feature preferences; the seed sets the ones it needs.",
  usage_allocations: "Usage ledger: budgets must survive the nightly reset.",
  usage_entitlements: "Usage ledger: entitlements are operator-managed.",
  usage_events: "Usage ledger: metered history for budgets and billing.",
  usage_lane_counters: "Usage ledger: rate-limit counters.",
  usage_seat_assignments: "Usage ledger: seat assignment of the member.",
  action_cost_calls: "Usage ledger: action cost history.",
  action_cost_records: "Usage ledger: action cost history.",
  hosted_checkout_claims: "Billing state, never reviewer content.",
  organization_professional_use_acceptances:
    "The organization's professional-use acceptance; written once, never reviewer content.",
  legal_list_verification_budgets: "Usage ledger: verification budget.",
  organization_file_objects:
    "Storage accounting, settled by the cleanup workers as objects are erased.",
  organization_file_usage:
    "Storage accounting, settled by the cleanup workers as objects are erased.",
  buffer_object_cleanup_intents:
    "Storage tombstones: they must outlive the rows they erase.",
  entity_deletion_cleanup_requests:
    "Storage tombstones: they must outlive the rows they erase.",
  template_deletion_cleanup_requests:
    "Storage tombstones: they must outlive the rows they erase.",
  mcp_web_handoff: "Short-lived OAuth state; never reviewer content.",
  mcp_oauth_clients: "OAuth data: never touched by the reset.",
  mcp_oauth_state: "OAuth data: never touched by the reset.",
  mcp_user_connections: "OAuth data: never touched by the reset.",
  service_oauth_clients: "OAuth data: never touched by the reset.",
  mcp_connectors: "Integration credentials: never touched by the reset.",
  mcp_connector_authorization_reviews:
    "Integration authorization history: never touched by the reset.",
  sharepoint_connections: "OAuth data: never touched by the reset.",
  sharepoint_oauth_state: "OAuth data: never touched by the reset.",
  business_registry_credentials:
    "Integration credentials: never touched by the reset.",
  feedback_reports: "Product feedback the operators read.",
  chat_content_v3_backfill_receipts:
    "Repair receipts the operators read; identifiers only, never chat content.",
  sanctions_organization_marks:
    "Scheduler-maintained screening state; holds no reviewer content.",
  sanctions_monitoring_backfills:
    "Scheduler-maintained screening state; holds no reviewer content.",
} as const satisfies Record<string, string>;

/**
 * Organization-scoped tables the reset empties for the review organization,
 * by `organization_id`, in this order: a table that references another
 * without a cascade comes before it (`reset-scope.test.ts` checks the order
 * against the schema). Workspace-only tables go with their matter.
 */
export const REVIEW_RESET_CLEARED_TABLES = [
  "agent_skill_comments",
  "agent_skill_proposals",
  "agent_skill_resources",
  "agent_skill_revisions",
  "agent_skills",
  "ai_memories",
  "anonymization_allowlist_entries",
  "anonymization_blacklist_entries",
  "bilingual_translation_rows",
  "bilingual_translation_runs",
  "billing_arrangements",
  "billing_codes",
  "case_law_research_answers",
  "case_law_research_columns",
  "chat_run_log_entries",
  "chat_run_logs",
  "chat_secrets",
  "chat_threads",
  "chat_tool_grants",
  "chat_turns",
  "clause_categories",
  "clause_variants",
  "clause_versions",
  "clauses",
  "contact_extraction_uploads",
  "contact_import_requests",
  "contact_relationships",
  "contact_search_document_preview_passages",
  "contact_search_documents",
  "contacts",
  "correspondence",
  "correspondence_allowed_sender_matters",
  "correspondence_attachments",
  "correspondence_drop_logs",
  "correspondence_filers",
  "desktop_presence",
  "desktop_runners",
  "desktop_time_entry_batches",
  "document_processing_runs",
  "document_reference_counters",
  "document_review_findings",
  "document_review_parties",
  "document_review_reference_passages",
  "document_review_runs",
  "document_translation_runs",
  "document_translation_units",
  "entity_version_ai_summaries",
  "entity_views",
  "extracted_content",
  "extraction_runs",
  "file_chat_threads",
  "file_comparison_uploads",
  "flow_definitions",
  "legal_reader_annotations",
  "legal_reader_answers",
  "matter_counters",
  "matter_inbound_addresses",
  "notifications",
  "number_series",
  "number_series_allocations",
  "number_series_counters",
  "office_file_evidence",
  "pending_uploads",
  "playbook_definition_versions",
  "playbook_definitions",
  "rate_tables",
  "sanctions_contact_marks",
  "sanctions_contact_matches",
  "sanctions_contact_screenings",
  "sanctions_screening_events",
  "saved_searches",
  "saved_time_narratives",
  "scout_runs",
  "search_document_preview_passages",
  "search_documents",
  "search_history_entries",
  "search_history_tombstones",
  "search_history_owners",
  "search_projection_repair_queue",
  "seller_profiles",
  "signal_events",
  "signals",
  "style_sets",
  "template_categories",
  "template_chat_threads",
  "template_clauses",
  "template_fills",
  "template_lookup_format_user_defaults",
  "template_lookup_formats",
  "template_persistence_requests",
  "template_recipes",
  "template_versions",
  "templates",
  "time_daily_targets",
  "time_entry_suggestions",
  "time_entry_timer_states",
  "time_timer_confirmations",
  "time_timers",
  "vat_rates",
  "workspace_contacts",
  "workspace_search_document_preview_passages",
  "workspace_search_documents",
  "workspace_view_templates",
  // Referenced without a cascade by tables above.
  "correspondence_allowed_senders",
  "document_types",
] as const;

/**
 * Matters leave through the authorized matter deletion before the sweep runs
 * (its own coverage test proves what goes with a matter); the sweep only runs
 * once none is left.
 */
export const REVIEW_RESET_MATTER_TABLE = "workspaces";

/** Tables without an organization column the sweep empties by hand first. */
export const REVIEW_RESET_MANUAL_TABLES = ["user_files"] as const;

const retainedTables: ReadonlySet<PgTable> = new Set(
  WORKSPACE_DELETION_RETAINED_TABLES,
);

const isBillingRoot = (table: PgTable) =>
  !getTableConfig(table).foreignKeys.some(
    (key) =>
      key.onDelete === "cascade" &&
      key.reference().foreignTable !== table &&
      retainedTables.has(key.reference().foreignTable),
  );

/**
 * Billing records outlive an authorized matter deletion, which refuses a
 * matter that still has them (`WORKSPACE_DELETION_RETAINED_TABLES`), so the
 * reset empties them before the matters, as the owner, stage by stage
 * (`WORKSPACE_DELETION_RETAINED_STAGES`). Only the roots are named: a
 * retained table that cascades from another goes with it.
 */
const REVIEW_RESET_BILLING_STAGES = WORKSPACE_DELETION_RETAINED_STAGES.map(
  (stage) =>
    stage.filter(isBillingRoot).map((table) => getTableConfig(table).name),
);

export const REVIEW_RESET_BILLING_TABLES = REVIEW_RESET_BILLING_STAGES.flat();

/**
 * Delete the organization's rows from `names` in one statement, so
 * restrictive references among them are checked once all are gone. Returns
 * the rows removed per table.
 */
const removeOrganizationRows = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  names: readonly string[],
): Promise<Map<string, number>> => {
  const removals = names.map((name, index) => ({
    name,
    alias: sql.identifier(`removed_${index}`),
  }));
  // audit: skip - one step of the reset's table deletes; totals go to the system audit
  const rows = executedRows(
    await tx.execute(
      sql`WITH ${sql.join(
        removals.map(
          ({ name, alias }) =>
            sql`${alias} AS (DELETE FROM ${sql.identifier(name)} WHERE organization_id = ${organizationId} RETURNING 1)`,
        ),
        sql`, `,
      )} SELECT ${sql.join(
        removals.map(
          ({ name, alias }) =>
            sql`(SELECT count(*)::int FROM ${alias}) AS ${sql.identifier(name)}`,
        ),
        sql`, `,
      )}`,
    ),
  );
  const counts = rows.at(0);
  return new Map(
    removals.map(({ name }) => [
      name,
      isRecord(counts) && typeof counts[name] === "number" ? counts[name] : 0,
    ]),
  );
};

/**
 * Empty the review organization's billing records while its matters still
 * stand, so the authorized matter deletion that follows can take them: one
 * statement per stage. None of these tables forces row security on its owner
 * (`reset-scope.test.ts`). Returns the rows removed per table.
 */
export const clearReviewOrganizationBilling = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<Map<string, number>> => {
  const removed = new Map<string, number>();
  const cleared = await inOrder(REVIEW_RESET_BILLING_STAGES, async (stage) => {
    for (const [name, rows] of await removeOrganizationRows(
      tx,
      organizationId,
      stage,
    )) {
      removed.set(name, rows);
    }
    return Result.ok(undefined);
  });
  cleared.unwrap("The billing stages report no errors");
  return removed;
};

/**
 * Empty every cleared table for one organization, in the owner transaction
 * that already recorded the organization's storage erasure. Returns the rows
 * removed per table.
 */
export const sweepReviewOrganization = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
): Promise<Map<string, number>> => {
  // audit: skip - the reset sweep; the run's totals go to the system audit
  const workspaceRows = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId));
  const workspaceIds = workspaceRows.map(({ id }) => id);
  const removed = new Map<string, number>();
  // Chat attachments name no organization; their rows hold their threads
  // (`user_files.thread_id` restricts), and the storage census already
  // recorded their objects. The organization deletion removes them the same way.
  const attachments = await tx
    .delete(userFiles)
    .where(
      inArray(
        userFiles.threadId,
        tx
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(eq(chatThreads.organizationId, organizationId)),
      ),
    )
    .returning({ id: userFiles.id });
  removed.set("user_files", attachments.length);
  await tx.execute(
    sql`SELECT set_config(${CORRESPONDENCE_REVIEW_RESET_SETTING.organizationId}, ${organizationId}, true)`,
  );
  const applicationTables = new Set(
    (
      await tx
        .select({
          name: sql<string>`c.relname`,
        })
        .from(
          sql`pg_catalog.pg_class c INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`,
        ).where(sql`n.nspname = current_schema() AND c.relforcerowsecurity
      AND has_table_privilege(${stella.name}, c.oid, 'DELETE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy policy
        WHERE policy.polrelid = c.oid AND policy.polcmd IN ('*', 'd')
          AND policy.polpermissive AND 0 = ANY(policy.polroles)
          AND strpos(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), 'CURRENT_USER') > 0
          AND strpos(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), 'pg_get_userbyid') > 0)`)
    ).map(({ name }) => name),
  );
  const swept = await inOrder(REVIEW_RESET_CLEARED_TABLES, async (name) => {
    const clear = async (deleteTx: Transaction) => {
      const rows = await removeOrganizationRows(deleteTx, organizationId, [
        name,
      ]);
      removed.set(name, rows.get(name) ?? 0);
    };
    // Explicit owner cleanup policies cover user and feature-hidden rows.
    // The remaining application policies use the entire organization matter set.
    if (applicationTables.has(name)) {
      await runScopedWorkInTransaction({
        tx,
        organizationId,
        userId,
        workspaceScope: {
          type: WORKSPACE_ACCESS_MODE.explicit,
          workspaceIds,
        },
        fn: clear,
      });
      return Result.ok(undefined);
    }
    await clear(tx);
    return Result.ok(undefined);
  });
  swept.unwrap("The sweep's table deletes report no errors");
  await tx.execute(
    sql`SELECT set_config(${CORRESPONDENCE_REVIEW_RESET_SETTING.organizationId}, '', true)`,
  );
  return removed;
};
