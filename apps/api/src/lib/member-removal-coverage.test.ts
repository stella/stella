import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

import * as agentSchema from "@/api/db/agent-auth-schema";
import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";

import { ORGANIZATION_MEMBER_CLEANUP_TABLES } from "./member-assignment-offboarding";

const RETAINED_MEMBER_COLUMNS = {
  "entity_versions.collaboration_contributor_user_ids":
    "Contribution history, not membership or write authority.",
  "legal_list_generation_candidates.suggested_assignee_user_ids":
    "Assignment suggestions; accepting a suggestion validates current membership.",
  "audit_logs.user_id": "Audit performer history.",
  "audit_logs.trigger_user_id": "Audit trigger history.",
  "audit_logs.approved_by_user_id": "Audit approval history.",
  "buffer_object_cleanup_intents.writer_user_id":
    "Storage erasure receipt; retained for cleanup.",
  "time_entries.approved_by_user_id": "Billing approval history.",
  "time_entries.returned_by_user_id": "Billing return history.",
  "usage_allocations.seat_scope_user_id":
    "Accounting scope; active seat assignment is membership-bound.",

  "agent_delegation.user_id":
    "Credential revocation remains owned by auth-artifacts in the existing removal hooks.",
  "agent_registration.bound_user_id":
    "Credential revocation remains owned by auth-artifacts in the existing removal hooks.",
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
  "correspondence.assignee_id":
    "Existing correspondence offboarding owns cleanup; attribution columns remain history.",
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
  "folio_collab_room_tokens.user_id":
    "Short-lived operation; current membership is revalidated before use.",
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
  "time_entries.approver_user_id":
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
  "apikey.reference_id":
    "Credential revocation remains owned by auth-artifacts in the existing removal hooks.",
  "oauth_access_token.user_id":
    "Credential revocation remains owned by auth-artifacts in the existing removal hooks.",
  "oauth_client.user_id":
    "Account-scoped record; organization removal does not erase the user account.",
  "oauth_consent.user_id":
    "Credential revocation remains owned by auth-artifacts in the existing removal hooks.",
  "oauth_refresh_token.user_id":
    "Credential revocation remains owned by auth-artifacts in the existing removal hooks.",
  "session.user_id":
    "Credential revocation remains owned by auth-artifacts in the existing removal hooks.",
  "two_factor.user_id":
    "Account-scoped record; organization removal does not erase the user account.",
} satisfies Record<string, string>;

test("every schema member reference has an organization removal disposition", () => {
  const cleanup = new Set(
    ORGANIZATION_MEMBER_CLEANUP_TABLES.map(
      (table) => getTableConfig(table).name,
    ),
  );
  const classified = new Map(Object.entries(RETAINED_MEMBER_COLUMNS));
  const seen = new Set<string>();
  const missing: string[] = [];
  const tables = new Set(
    Object.values({ ...schema, ...authSchema, ...agentSchema }),
  );
  for (const value of tables) {
    if (!is(value, PgTable)) {
      continue;
    }
    const config = getTableConfig(value);
    const memberColumns = new Set(
      config.columns
        .filter(({ name }) => /(?:user_ids?|member_ids?)$/u.test(name))
        .map(({ name }) => name),
    );
    for (const fk of config.foreignKeys) {
      const reference = fk.reference();
      if (
        !["user", "member"].includes(
          getTableConfig(reference.foreignTable).name,
        )
      ) {
        continue;
      }
      for (const column of reference.columns) {
        memberColumns.add(column.name);
      }
    }
    for (const columnName of memberColumns) {
      const key = `${config.name}.${columnName}`;
      seen.add(key);
      if (!cleanup.has(config.name) && !classified.has(key)) {
        missing.push(key);
      }
    }
  }

  expect(missing).toEqual([]);
  expect([...classified.keys()].filter((key) => !seen.has(key))).toEqual([]);
  // JSON actor grants have no FK; they belong to the same cleanup census.
  expect(cleanup.has(getTableConfig(schema.flowRuns).name)).toBe(true);
});
