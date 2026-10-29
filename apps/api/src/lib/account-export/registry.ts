import { panic } from "better-result";

import { USER_OWNED_TABLE_NAMES } from "./user-owned-tables.gen";
import type { UserOwnedTableName } from "./user-owned-tables.gen";

const ACCOUNT_EXPORT_EXEMPT_REASON = {
  noUserContent: "no user content",
  derived: "derived/cache",
  security: "security artifact",
  organization: "org-owned",
} as const;
type AccountExportDisposition =
  | { type: "exported" }
  | {
      type: "exempt";
      reason: (typeof ACCOUNT_EXPORT_EXEMPT_REASON)[keyof typeof ACCOUNT_EXPORT_EXEMPT_REASON];
    };

// Actor-attribution FKs on shared legal records do not confer personal ownership.
// Mixed tables export only their private subset, enforced by the page owner.
export const ACCOUNT_EXPORT_REGISTRY = {
  account: { type: "exempt", reason: ACCOUNT_EXPORT_EXEMPT_REASON.security },
  account_audit_logs: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  account_deletion_requests: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  account_exports: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  action_cost_records: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  agent_delegation: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  agent_registration: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  agent_skill_comments: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  agent_skill_proposals: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  agent_skill_revisions: { type: "exported" },
  agent_skills: { type: "exported" },
  ai_memories: { type: "exported" },
  anonymization_allowlist_entries: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  anonymization_blacklist_entries: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  apikey: { type: "exempt", reason: ACCOUNT_EXPORT_EXEMPT_REASON.security },
  bilingual_translation_runs: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  case_law_matter_links: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  case_law_research_columns: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  cell_metadata: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  chat_message_revisions: { type: "exported" },
  chat_messages: { type: "exported" },
  chat_secrets: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  chat_threads: { type: "exported" },
  chat_tool_grants: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  chat_turns: { type: "exempt", reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived },
  clauses: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  contact_extraction_uploads: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  contact_import_requests: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  contacts: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  correspondence: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  correspondence_allowed_senders: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  correspondence_filers: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  desktop_edit_handoffs: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  desktop_edit_sessions: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  desktop_presence: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  desktop_time_entry_batches: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  document_processing_runs: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  document_review_finding_decisions: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  document_review_findings: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  document_review_runs: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  document_translation_runs: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  docx_suggestions: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  entities: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  entity_views: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  expenses: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  extraction_runs: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  feature_enrolments: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.noUserContent,
  },
  feedback_reports: { type: "exported" },
  file_chat_threads: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  file_comparison_uploads: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  flow_definitions: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  folio_collab_contributions: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  folio_collab_room_tokens: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  folio_collab_rooms: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  infosoud_tracked_cases: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  invitation: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  legal_list_claim_review_events: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  legal_list_fact_details: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  legal_list_generation_runs: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  legal_list_item_comments: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  legal_list_item_reviews: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  legal_list_item_sources: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  legal_list_items: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  legal_list_verification_read_receipts: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  legal_list_verification_runs: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  legal_lists: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  legal_reader_annotations: { type: "exported" },
  legal_reader_answers: { type: "exported" },
  matter_inbound_addresses: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  mcp_oauth_state: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  mcp_user_connections: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  mcp_web_handoff: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  member: { type: "exported" },
  notifications: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  oauth_access_token: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  oauth_client: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  oauth_consent: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  oauth_refresh_token: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  organization_professional_use_acceptances: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  pdf_signing_sessions: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  pending_uploads: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  playbook_definition_versions: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  playbook_definitions: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  rate_entries: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  report_exports: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  sanctions_contact_matches: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  saved_searches: { type: "exported" },
  saved_time_narratives: { type: "exported" },
  search_history_entries: { type: "exported" },
  search_history_country_clears: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  search_history_owners: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  search_history_tombstones: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  session: { type: "exempt", reason: ACCOUNT_EXPORT_EXEMPT_REASON.security },
  sharepoint_connections: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  sharepoint_oauth_state: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.security,
  },
  signal_events: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  signals: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  style_sets: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  task_assignees: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  template_chat_threads: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  template_fills: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  template_lookup_format_user_defaults: { type: "exported" },
  template_persistence_requests: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  template_recipes: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  template_versions: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  templates: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  time_entries: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  time_entry_suggestions: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  time_entry_timer_states: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  time_timer_confirmations: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  time_timers: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  two_factor: { type: "exempt", reason: ACCOUNT_EXPORT_EXEMPT_REASON.security },
  usage_allocations: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  usage_events: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  usage_lane_counters: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.derived,
  },
  usage_seat_assignments: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  user: { type: "exported" },
  user_files: { type: "exported" },
  user_professional_use_acceptances: { type: "exported" },
  work_obligation_events: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  work_obligations: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  workspace_members: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
  workspace_view_templates: { type: "exported" },
  workspaces: {
    type: "exempt",
    reason: ACCOUNT_EXPORT_EXEMPT_REASON.organization,
  },
} as const satisfies Record<UserOwnedTableName, AccountExportDisposition>;

type AccountExportRegistry = typeof ACCOUNT_EXPORT_REGISTRY;
export type ExportedAccountTableName = {
  [
    Table in UserOwnedTableName
  ]: AccountExportRegistry[Table]["type"] extends "exported" ? Table : never;
}[UserOwnedTableName];

const isExported = (
  table: UserOwnedTableName,
): table is ExportedAccountTableName =>
  ACCOUNT_EXPORT_REGISTRY[table].type === "exported";
export const EXPORTED_ACCOUNT_TABLE_NAMES =
  USER_OWNED_TABLE_NAMES.filter(isExported);

type AssertAccountExportRegistryOptions = {
  tableNames: readonly string[];
  registry: Readonly<Record<string, AccountExportDisposition>>;
  projections: Readonly<Record<string, unknown>>;
};
export const assertAccountExportRegistry = ({
  tableNames,
  registry,
  projections,
}: AssertAccountExportRegistryOptions): void => {
  const schemaNames = new Set(tableNames);
  for (const table of schemaNames) {
    if (!Object.hasOwn(registry, table)) {
      panic(`Account export disposition missing: ${table}`);
    }
  }
  for (const [table, disposition] of Object.entries(registry)) {
    if (!schemaNames.has(table)) {
      panic(`Account export disposition has no user table: ${table}`);
    }
    if (
      (disposition.type === "exported") !==
      Object.hasOwn(projections, table)
    ) {
      panic(
        `Account export projection does not match its disposition: ${table}`,
      );
    }
  }
  for (const table of Object.keys(projections)) {
    if (!Object.hasOwn(registry, table)) {
      panic(`Account export projection has no disposition: ${table}`);
    }
  }
};
