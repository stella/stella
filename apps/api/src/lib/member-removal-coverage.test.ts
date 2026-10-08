import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import type { PgColumn } from "drizzle-orm/pg-core";

import * as agentSchema from "@/api/db/agent-auth-schema";
import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";

import {
  ORGANIZATION_MEMBER_CLEANUP_COLUMNS,
  WORKSPACE_MEMBER_CLEANUP_COLUMNS,
} from "./member-assignment-offboarding-census";

/**
 * A column names a member when it references the user or member table, when
 * its name says so, or when it is a JSON column listed as holding member ids.
 * Every such column needs a disposition on every removal path: cleared or
 * reassigned (from the path's own cleanup list) or retained with a reason.
 */
const MEMBER_REFERENCE_NAME =
  /(?:user|member|owner|assignee|inviter|author|reviewer|actor|approver|attorney)_ids?$|(?:^|_)by$/u;

/** JSON columns whose documents can hold user or member ids. */
const JSON_MEMBER_REFERENCE_COLUMNS = [
  "audit_logs.metadata",
  "audit_logs.changes",
  "cell_metadata.metadata",
  "chat_messages.content",
  "chat_run_log_entries.chunk",
  "entity_versions.collaboration_contributor_user_ids",
  "fields.content",
  "flow_run_steps.output",
  "flow_runs.trigger_source",
  "legal_list_generation_candidates.suggested_assignee_user_ids",
  "saved_searches.criteria",
  "signal_events.payload",
  "signals.evidence",
  "work_obligation_events.details",
  "usage_provider_webhook_events.payload",
  "time_entry_suggestions.evidence",
] as const;

/** JSON columns read and found to hold no user or member id. */
const JSON_COLUMNS_WITHOUT_MEMBER_REFERENCES = [
  "account_deletion_requests.storage_cleanup",
  "agent_skills.metadata",
  "anonymization_blacklist_entries.variants",
  "bilingual_translation_rows.warnings",
  "bilingual_translation_runs.glossary",
  "case_law_decision_supplements.document_ast",
  "case_law_decision_supplements.metadata",
  "case_law_decisions.sections",
  "case_law_decisions.document_ast",
  "case_law_decisions.analysis",
  "case_law_decisions.metadata",
  "case_law_judges.external_refs",
  "case_law_polarity_rules.surface_forms",
  "case_law_provision_extractions.unresolved_counts",
  "case_law_reconciliation_items.payload",
  "case_law_replay_audit_events.details",
  "case_law_replay_batches.gate_verdict",
  "case_law_research_answers.answer",
  "case_law_research_answers.run",
  "case_law_research_columns.content",
  "case_law_research_columns.tool",
  "case_law_sources.config",
  "case_law_sources.descriptor",
  "chat_thread_compactions.summary",
  "chat_thread_names.target",
  "clause_variants.body",
  "clause_versions.body",
  "clauses.body",
  "clauses.metadata",
  "contact_import_requests.result",
  "contacts.emails",
  "contacts.phones",
  "contacts.addresses",
  "contacts.metadata",
  "contacts.bank_accounts",
  "contacts.billing_address",
  "correspondence.original_signature",
  "correspondence.sender",
  "correspondence.recipients_to",
  "correspondence.recipients_cc",
  "correspondence.references",
  "correspondence_allowed_senders.approved_by_display",
  "correspondence_filers.filed_by_display",
  "database_backfill_states.batch",
  "desktop_edit_handoffs.linked_account",
  "desktop_edit_sessions.checkpoint_scan_warnings",
  "document_review_findings.payload",
  "document_review_parties.parties",
  "document_review_runs.basis",
  "document_review_runs.skipped",
  "document_translation_runs.warnings",
  "document_translation_units.application",
  "document_translation_units.warnings",
  "docx_suggestions.op_payload",
  "entities.organizer",
  "entities.attendees",
  "entities.recurrence",
  "entities.external_data",
  "entities.metadata",
  "entity_versions.source",
  "entity_views.layout",
  "eu_completion_approvals.reviewed_counts",
  "eu_completion_controls.batch",
  "eu_completion_receipts.provenance",
  "feedback_reports.context",
  "feedback_reports.deliveries",
  "flow_definitions.steps",
  "flow_definitions.trigger",
  "flow_runs.definition_snapshot",
  "folio_collab_room_tokens.permissions",
  "folio_collab_rooms.docx_checkpoint_scan_warnings",
  "usage_provider_webhook_events.replay_audit",
  "justifications.content",
  "justifications.bounding_boxes",
  "legal_list_claim_review_events.payload",
  "legal_list_claims.anchor",
  "legal_list_claims.refs",
  "legal_list_claims.record_conflict",
  "legal_list_generation_candidate_sources.locator",
  "legal_list_item_sources.locator",
  "legal_list_verification_runs.evidence",
  "legislation_documents.sections",
  "legislation_documents.document_ast",
  "legislation_documents.metadata",
  "legislation_sources.config",
  "legislation_sources.descriptor",
  "mcp_connector_authorization_reviews.observed_endpoint_origins",
  "mcp_connector_authorization_reviews.approved_endpoint_origins",
  "mcp_connectors.oauth_confirmed_endpoint_origins",
  "mcp_oauth_clients.registration_response",
  "mcp_user_connections.cached_tools",
  "notifications.metadata",
  "organization_settings.practice_jurisdictions",
  "organization_settings.native_tool_overrides",
  "organization_settings.disabled_native_tools",
  "pdf_signing_sessions.signer_certificate_chain",
  "pdf_signing_sessions.stamp",
  "pending_uploads.purpose_data",
  "pending_uploads.finalized_result",
  "pending_uploads.rejection_details",
  "playbook_definition_versions.scope",
  "playbook_definition_versions.positions",
  "playbook_definitions.scope",
  "playbook_definitions.positions",
  "properties.content",
  "properties.tool",
  "property_dependencies.condition",
  "report_exports.template_ref",
  "report_exports.layout",
  "sanctions_contact_matches.match",
  "sanctions_entry_payloads.payload",
  "sanctions_screening_events.new_match",
  "sanctions_screening_events.old_match",
  "scheduler_jobs.schedule",
  "scheduler_jobs.payload",
  "signals.subject",
  "signals.suggestions",
  "signals.accepted_result",
  "soft_law_sources.descriptor",
  "soft_law_document_versions.raw_objects",
  "soft_law_document_versions.metadata",
  "soft_law_document_versions.source_dates",
  "soft_law_ingestion_attempts.entry",
  "system_audit_runs.counts",
  "template_fills.structure_errors",
  "template_persistence_requests.result",
  "template_recipes.definition",
  "template_versions.manifest",
  "templates.manifest",
  "templates.origin",
  "workspace_view_templates.layout",
  "workspace_view_templates.template_properties",
  "workspace_views.layout",
  "oauth_access_token.confirmation",
  "oauth_client.metadata",
  "oauth_client_resource.metadata",
  "oauth_refresh_token.confirmation",
  "oauth_resource.custom_claims",
  "oauth_resource.metadata",
  "agent_trusted_issuer.attestation_policy",
] as const;

/** Member references both removal paths keep, and why. */
const RETAINED_MEMBER_COLUMNS = {
  "entity_versions.collaboration_contributor_user_ids":
    "Contribution history, not membership or write authority.",
  "legal_list_generation_candidates.suggested_assignee_user_ids":
    "Assignment suggestions; accepting a suggestion validates current membership.",
  "sanctions_contact_matches.reviewed_by":
    "Screening review attribution; current membership gates review actions.",
  "sanctions_screening_events.reviewer_id":
    "Screening decision history; attribution grants no membership or review authority.",
  "audit_logs.user_id": "Audit performer history.",
  "feature_enrolments.user_id":
    "The person's own feature opt-in; access also requires current membership, and the row cascades with the user and organization.",
  "audit_logs.trigger_user_id": "Audit trigger history.",
  "audit_logs.approved_by_user_id": "Audit approval history.",
  "buffer_object_cleanup_intents.writer_user_id":
    "Storage erasure receipt; retained for cleanup.",
  "time_entries.approved_by_user_id": "Billing approval history.",
  "time_entries.returned_by_user_id": "Billing return history.",
  "usage_allocations.seat_scope_user_id":
    "Accounting scope; active seat assignment is membership-bound.",

  "account_deletion_requests.user_id":
    "Account-scoped record; organization removal does not erase the user account.",
  "action_cost_records.user_id":
    "Retained accounting, telemetry or contribution history; no membership grant.",
  "agent_skill_comments.author_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "agent_skill_comments.resolved_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "agent_skill_proposals.author_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "agent_skill_proposals.reviewer_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "agent_skill_revisions.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "agent_skills.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "ai_memories.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "ai_memories.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "anonymization_allowlist_entries.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "anonymization_blacklist_entries.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "anonymization_blacklist_entries.updated_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "bilingual_translation_runs.requested_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "case_law_matter_links.linked_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "case_law_research_columns.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "cell_metadata.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "cell_metadata.updated_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "chat_messages.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "chat_threads.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "chat_turns.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "clauses.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "contact_extraction_uploads.user_id":
    "Short-lived operation; current membership is revalidated before use.",
  "contact_import_requests.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "correspondence_allowed_senders.owner_user_id":
    "Existing correspondence offboarding owns cleanup; attribution columns remain history.",
  "correspondence_allowed_senders.approved_by":
    "Existing correspondence offboarding owns cleanup; attribution columns remain history.",
  "correspondence_filers.filed_by_user_id":
    "Existing correspondence offboarding owns cleanup; attribution columns remain history.",
  "document_processing_runs.requested_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "document_review_findings.decided_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "document_review_findings.applied_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "document_review_runs.requested_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "document_translation_runs.requested_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "docx_suggestions.resolved_by_user_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "entities.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "entities.last_edited_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "entity_views.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "eu_completion_approvals.approved_by":
    "Corpus-completion operator attribution as free text; no user id and no matter membership.",
  "eu_completion_approvals.supervised_by":
    "Corpus-completion operator attribution as free text; no user id and no matter membership.",
  "eu_completion_controls.changed_by":
    "Corpus-completion operator attribution as free text; no user id and no matter membership.",
  "expenses.user_id":
    "Retained billing records; current membership gates time APIs and timers are closed by offboarding.",
  "extraction_runs.requested_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "feedback_reports.user_id":
    "Retained accounting, telemetry or contribution history; no membership grant.",
  "file_chat_threads.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "file_comparison_uploads.user_id":
    "Short-lived operation; current membership is revalidated before use.",
  "flow_definitions.created_by_user_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "folio_collab_contributions.user_id":
    "Retained accounting, telemetry or contribution history; no membership grant.",
  "folio_collab_rooms.seed_claimed_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "infosoud_tracked_cases.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "legal_list_claim_review_events.actor_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "legal_list_fact_details.updated_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "legal_list_generation_runs.requested_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "legal_list_item_comments.author_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "legal_list_item_reviews.reviewer_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "legal_list_item_sources.verified_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "legal_list_item_sources.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "legal_list_items.added_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "legal_list_verification_runs.requested_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "legal_list_verification_read_receipts.user_id":
    "Read-audit dedupe receipt; retained with the run, cascades on user deletion, and grants no membership.",
  "legal_lists.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "legal_reader_annotations.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "matter_inbound_addresses.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "matter_inbound_addresses.revoked_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "notifications.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "pending_uploads.user_id":
    "Short-lived operation; current membership is revalidated before use.",
  "playbook_definition_versions.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "playbook_definitions.approved_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "rate_entries.user_id":
    "Retained billing records; current membership gates time APIs and timers are closed by offboarding.",
  "report_exports.requested_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "saved_searches.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "saved_time_narratives.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "signal_events.actor_user_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "signals.assignee_user_id":
    "Retained workflow attribution; current membership gates access and actions.",
  "signals.created_by_user_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "style_sets.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "template_chat_threads.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "template_fills.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "template_lookup_format_user_defaults.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "template_persistence_requests.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "template_recipes.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "template_versions.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "templates.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "time_daily_targets.organization_id":
    "Target configuration; active membership is required to use the time APIs.",
  "time_daily_targets.user_id":
    "Target configuration; active membership is required to use the time APIs.",
  "time_entries.user_id":
    "Retained billing records; current membership gates time APIs and timers are closed by offboarding.",
  "time_entry_suggestions.user_id":
    "Retained billing records; current membership gates time APIs and timers are closed by offboarding.",
  "time_entry_timer_states.user_id":
    "Retained billing records; current membership gates time APIs and timers are closed by offboarding.",
  "time_timer_confirmations.user_id":
    "Retained billing records; current membership gates time APIs and timers are closed by offboarding.",
  "time_timers.user_id":
    "Retained billing records; current membership gates time APIs and timers are closed by offboarding.",
  "usage_allocations.allocated_by_user_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "usage_events.user_id":
    "Retained accounting, telemetry or contribution history; no membership grant.",
  "usage_lane_counters.user_id":
    "Retained accounting, telemetry or contribution history; no membership grant.",
  "usage_seat_assignments.assigned_by_user_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "usage_seat_assignments.organization_id":
    "Membership composite FK cascades on exact member deletion.",
  "usage_seat_assignments.user_id":
    "Membership composite FK cascades on exact member deletion.",
  "user_files.user_id":
    "Account-scoped record; organization removal does not erase the user account.",
  "work_obligation_events.actor_user_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "workspace_view_templates.user_id":
    "User-owned matter content or preferences; current organization/matter membership gates access.",
  "account.user_id":
    "Account-scoped record; organization removal does not erase the user account.",
  "oauth_client.user_id":
    "Account-scoped record; organization removal does not erase the user account.",
  "two_factor.user_id":
    "Account-scoped record; organization removal does not erase the user account.",
  "audit_logs.metadata": "Audit history.",
  "audit_logs.changes": "Audit history.",
  "cell_metadata.metadata":
    "Flag and lock attribution history; grants no matter membership.",
  "chat_messages.content":
    "Conversation history; tool payloads name members as they were.",
  "chat_run_log_entries.chunk":
    "Run log history; tool payloads name members as they were.",
  "fields.content":
    "A person property value; it names someone and grants nothing.",
  "flow_run_steps.output": "Review gate decision attribution history.",
  "saved_searches.criteria":
    "A filter value that names people; it grants nothing.",
  "signal_events.payload": "Signal assignment history.",
  "signals.evidence":
    "Derived from the obligation owner, which removal reassigns or clears.",
  "work_obligation_events.details": "Ownership change history.",
  "usage_provider_webhook_events.payload":
    "Provider entitlement record; active seat assignment is membership-bound.",
  "time_entry_suggestions.evidence":
    "Suggestion evidence history; names a membership row as it was.",
  "contacts.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "entity_versions.created_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "entity_versions.deleted_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "work_obligations.created_by_user_id":
    "Retained attribution or request history; this column grants no matter membership.",
  "scheduler_jobs.paused_by":
    "Retained attribution or request history; this column grants no matter membership.",
  "scheduler_jobs.locked_by": "A runner lease token, not a person.",
  "document_processing_runs.claimed_by": "A worker claim token, not a person.",
  "work_obligations.acknowledged_by_user_id":
    "Acknowledgement attribution; an ownership change resets it with the owner.",
} satisfies Record<string, string>;

/**
 * Member references organization removal clears and matter removal keeps:
 * the person stays a member of the organization.
 */
const MATTER_REMOVAL_RETAINED_COLUMNS = {
  "desktop_presence.user_id":
    "Organization-scoped presence; the person stays an organization member.",
  "member.user_id": "Organization membership outlives a matter removal.",
  "contacts.originating_attorney_id":
    "Organization-level attorney; the person stays an organization member.",
  "contacts.responsible_attorney_id":
    "Organization-level attorney; the person stays an organization member.",
  "flow_runs.trigger_source":
    "Every run step re-checks its actor's matter membership before it acts.",
  "mcp_user_connections.user_id":
    "Organization-scoped connection; the person stays an organization member.",
  "mcp_oauth_state.user_id":
    "Organization-scoped connection; the person stays an organization member.",
  "sharepoint_connections.user_id":
    "Organization-scoped connection; the person stays an organization member.",
  "sharepoint_oauth_state.user_id":
    "Organization-scoped connection; the person stays an organization member.",
  "invitation.inviter_id":
    "Organization invitation; the person stays an organization member.",
  "session.user_id":
    "Organization credential; the person stays an organization member.",
  "apikey.reference_id":
    "Organization credential; the person stays an organization member.",
  "oauth_access_token.user_id":
    "Organization credential; the person stays an organization member.",
  "oauth_refresh_token.user_id":
    "Organization credential; the person stays an organization member.",
  "oauth_consent.user_id":
    "Organization credential; the person stays an organization member.",
  "agent_registration.bound_user_id":
    "Organization credential; the person stays an organization member.",
  "agent_delegation.user_id":
    "Organization credential; the person stays an organization member.",
  "folio_collab_room_tokens.user_id":
    "Short-lived room token; current matter membership is revalidated before use.",
} satisfies Record<string, string>;

type CensusTable = {
  name: string;
  columns: readonly { name: string; json: boolean }[];
  memberForeignKeyColumns: readonly string[];
};

type RemovalPath = {
  name: string;
  cleanup: ReadonlySet<string>;
  retained: ReadonlyMap<string, string>;
};

const schemaTables = [
  ...new Set(Object.values({ ...schema, ...authSchema, ...agentSchema })),
].filter((value) => is(value, PgTable));

const COLUMN_KEYS = new Map<PgColumn, string>(
  schemaTables.flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns.map(
      (column) => [column, `${config.name}.${column.name}`] as const,
    );
  }),
);

const columnKey = (column: PgColumn) => {
  const key = COLUMN_KEYS.get(column);
  if (key === undefined) {
    throw new Error(`${column.name} is not a column of the schema`);
  }
  return key;
};

const schemaCensus = (): CensusTable[] =>
  schemaTables.map((table) => {
    const config = getTableConfig(table);
    return {
      name: config.name,
      columns: config.columns.map((column) => ({
        name: column.name,
        json: column.getSQLType().startsWith("json"),
      })),
      memberForeignKeyColumns: config.foreignKeys.flatMap((fk) => {
        const reference = fk.reference();
        return ["user", "member"].includes(
          getTableConfig(reference.foreignTable).name,
        )
          ? reference.columns.map(({ name }) => name)
          : [];
      }),
    };
  });

/** Every gap between the schema and the removal paths' dispositions. */
const memberReferenceGaps = ({
  tables,
  paths,
  jsonWithMembers,
  jsonWithoutMembers,
}: {
  tables: readonly CensusTable[];
  paths: readonly RemovalPath[];
  jsonWithMembers: ReadonlySet<string>;
  jsonWithoutMembers: ReadonlySet<string>;
}): string[] => {
  const gaps: string[] = [];
  const references = new Set<string>();
  const jsonColumns = new Set<string>();
  for (const table of tables) {
    for (const column of table.columns) {
      const key = `${table.name}.${column.name}`;
      if (column.json) {
        jsonColumns.add(key);
        if (!jsonWithMembers.has(key) && !jsonWithoutMembers.has(key)) {
          gaps.push(`unclassified JSON column ${key}`);
        }
      }
      if (
        MEMBER_REFERENCE_NAME.test(column.name) ||
        table.memberForeignKeyColumns.includes(column.name) ||
        jsonWithMembers.has(key)
      ) {
        references.add(key);
      }
    }
  }
  for (const key of [...jsonWithMembers, ...jsonWithoutMembers]) {
    if (!jsonColumns.has(key)) {
      gaps.push(`stale JSON classification ${key}`);
    }
  }
  for (const path of paths) {
    for (const key of references) {
      const cleared = path.cleanup.has(key);
      const retained = path.retained.has(key);
      if (!cleared && !retained) {
        gaps.push(`${path.name}: no disposition for ${key}`);
      }
      if (cleared && retained) {
        gaps.push(`${path.name}: ${key} is both cleared and retained`);
      }
    }
    for (const key of [...path.cleanup, ...path.retained.keys()]) {
      if (!references.has(key)) {
        gaps.push(`${path.name}: stale disposition ${key}`);
      }
    }
  }
  return gaps.toSorted();
};

const organizationPath: RemovalPath = {
  name: "organization",
  cleanup: new Set(
    ORGANIZATION_MEMBER_CLEANUP_COLUMNS.map(([column]) => columnKey(column)),
  ),
  retained: new Map(Object.entries(RETAINED_MEMBER_COLUMNS)),
};
const matterPath: RemovalPath = {
  name: "matter",
  cleanup: new Set(
    WORKSPACE_MEMBER_CLEANUP_COLUMNS.map(([column]) => columnKey(column)),
  ),
  retained: new Map([
    ...Object.entries(RETAINED_MEMBER_COLUMNS),
    ...Object.entries(MATTER_REMOVAL_RETAINED_COLUMNS),
  ]),
};
/** The schema census with one table replaced by a deliberately wrong fixture. */
const withTable = (
  name: string,
  change: (table: CensusTable) => CensusTable,
): CensusTable[] =>
  schemaCensus().map((table) => (table.name === name ? change(table) : table));

const census = {
  paths: [organizationPath, matterPath],
  jsonWithMembers: new Set<string>(JSON_MEMBER_REFERENCE_COLUMNS),
  jsonWithoutMembers: new Set<string>(JSON_COLUMNS_WITHOUT_MEMBER_REFERENCES),
};

describe("member removal schema coverage", () => {
  test("every column naming a member has a disposition on both removal paths", () => {
    expect(memberReferenceGaps({ ...census, tables: schemaCensus() })).toEqual(
      [],
    );
  });

  test("a new member column on a covered table needs its own disposition", () => {
    const tables = withTable("workspaces", (table) => ({
      name: table.name,
      columns: [
        ...table.columns,
        { name: "approver_user_id", json: false },
        { name: "reviewed_by", json: false },
      ],
      memberForeignKeyColumns: table.memberForeignKeyColumns,
    }));
    expect(memberReferenceGaps({ ...census, tables })).toEqual([
      "matter: no disposition for workspaces.approver_user_id",
      "matter: no disposition for workspaces.reviewed_by",
      "organization: no disposition for workspaces.approver_user_id",
      "organization: no disposition for workspaces.reviewed_by",
    ]);
  });

  test("a member foreign key and a new JSON column are both caught", () => {
    const tables = withTable("contacts", (table) => ({
      name: table.name,
      columns: [
        ...table.columns,
        { name: "partner", json: false },
        { name: "grants", json: true },
      ],
      memberForeignKeyColumns: [...table.memberForeignKeyColumns, "partner"],
    }));
    expect(memberReferenceGaps({ ...census, tables })).toEqual([
      "matter: no disposition for contacts.partner",
      "organization: no disposition for contacts.partner",
      "unclassified JSON column contacts.grants",
    ]);
  });

  test("a column one path clears still needs a reason on the other path", () => {
    const matterOnly = new Map(
      Object.entries(MATTER_REMOVAL_RETAINED_COLUMNS).filter(
        ([key]) => key !== "contacts.originating_attorney_id",
      ),
    );
    expect(
      memberReferenceGaps({
        ...census,
        tables: schemaCensus(),
        paths: [
          {
            ...matterPath,
            retained: new Map([
              ...Object.entries(RETAINED_MEMBER_COLUMNS),
              ...matterOnly,
            ]),
          },
        ],
      }),
    ).toEqual(["matter: no disposition for contacts.originating_attorney_id"]);
  });
});
