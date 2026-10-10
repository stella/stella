export type TableRetention =
  | { ttlColumn: string; sweeper: string }
  | { boundedBy: string };

export const TABLE_RETENTION = {
  mcp_user_connections: {
    boundedBy:
      "One saved connection per organization, account and connector; cascade-deleted with any owner.",
  },
  chat_secrets: {
    boundedBy:
      "One receipt per thread tool call, cascade-deleted with its thread; encrypted payloads expire through chat.purgeSecrets.",
  },
  desktop_presence: {
    boundedBy:
      "One observation per account, organization and installation, overwritten by heartbeats and cascade-deleted with the account or organization.",
  },
  task_assignees: {
    boundedBy:
      "Unique task and user assignments, cascade-deleted with either parent.",
  },
  work_obligation_events: {
    boundedBy:
      "Obligation lifecycle history, cascade-deleted with its matter or obligation.",
  },
  search_projection_repair_queue: {
    boundedBy:
      "One pending repair per projection target, removed by the repair drain after projection success or source deletion.",
  },
  feedback_reports: {
    boundedBy:
      "Rate-limited public intake with fingerprint deduplication and receipt lifecycle.",
  },
  agent_registration: {
    ttlColumn: "expires_at",
    sweeper: "auth.sweepRegistrations",
  },
  registration_daily_budget: {
    ttlColumn: "day",
    sweeper: "auth.sweepRegistrations",
  },
  oauth_client: { ttlColumn: "created_at", sweeper: "auth.sweepRegistrations" },
  oauth_client_resource: {
    boundedBy: "Cascade-deleted with its client or resource.",
  },
  oauth_client_assertion: {
    ttlColumn: "expires_at",
    sweeper: "auth.sweepRegistrations",
  },
  verification: { ttlColumn: "expires_at", sweeper: "auth.sweepRegistrations" },
  agent_assertion_replay: {
    ttlColumn: "expires_at",
    sweeper: "auth.sweepRegistrations",
  },
  agent_delegation: {
    boundedBy: "Authenticated account and organization delegation lifecycle.",
  },
  agent_skills: {
    boundedBy: "Organization-owned skill configuration and deletion.",
  },
  audit_logs: {
    boundedBy: "Organization-owned audit history and organization deletion.",
  },
  system_audit_runs: {
    ttlColumn: "created_at",
    sweeper: "audit.purgeSystemRuns",
  },
  billing_arrangements: {
    boundedBy: "Organization-owned billing configuration and deletion.",
  },
  buffer_object_cleanup_intents: {
    boundedBy: "Durable cleanup queue drained by buffer-intent reconciliation.",
  },
  desktop_edit_sessions: {
    boundedBy:
      "Authenticated account-owned editing sessions with expiry and revocation.",
  },
  document_processing_runs: {
    boundedBy:
      "Organization-owned processing history and organization deletion.",
  },
  document_reference_counters: {
    boundedBy:
      "Organization-owned reference counters and organization deletion.",
  },
  document_types: {
    boundedBy: "Organization-owned document configuration and deletion.",
  },
  entity_deletion_cleanup_requests: {
    boundedBy: "Durable deletion queue drained by entity deletion cleanup.",
  },
  entity_versions: {
    boundedBy: "Matter-owned version history and document deletion.",
  },
  fields: { boundedBy: "Matter-owned field configuration and deletion." },
  folio_collab_contributions: {
    boundedBy: "Matter-owned collaboration history and matter deletion.",
  },
  organization_access_states: {
    boundedBy: "One access state per organization, deleted with its owner.",
  },
  organization_configured_access: {
    boundedBy: "Organization-owned access configuration and deletion.",
  },
  organization_file_objects: {
    boundedBy: "Organization-owned objects reconciled during storage deletion.",
  },
  organization_file_usage: {
    boundedBy: "Organization-owned file accounting and deletion.",
  },
  hosted_checkout_claims: {
    boundedBy:
      "At most one claim per organization, taken over in place once expired and deleted with its owner.",
  },
  organization_professional_use_acceptances: {
    boundedBy:
      "One acceptance per organization, written once and deleted with its owner.",
  },
  user_professional_use_acceptances: {
    boundedBy:
      "One acceptance per account, written once and deleted with the account.",
  },
  usage_allocations: {
    boundedBy: "Organization-owned usage accounting and deletion.",
  },
  usage_entitlements: {
    boundedBy: "Organization-owned usage configuration and deletion.",
  },
  usage_provider_webhook_events: {
    boundedBy:
      "Provider-authenticated event identity and replay-safe processing.",
  },
  usage_seat_assignments: {
    boundedBy: "Organization-owned seat configuration and deletion.",
  },
  template_lookup_format_user_defaults: {
    boundedBy:
      "Authenticated account-owned formatting preferences and deletion.",
  },
  pending_uploads: {
    boundedBy:
      "Authenticated organization-owned upload staging, settled or cancelled by its owner.",
  },
  cell_metadata: {
    boundedBy: "Matter-owned cell metadata and document deletion.",
  },
  search_document_preview_passages: {
    boundedBy:
      "Derived document projection replaced or deleted with its source.",
  },
  search_documents: {
    boundedBy:
      "Derived document projection replaced or deleted with its source.",
  },
  // A public decision read may fetch a deferred document itself, once per
  // decision, and store it through the ingestion path.
  case_law_search_documents: {
    boundedBy:
      "Derived document projection replaced or deleted with its source.",
  },
  case_law_search_document_preview_passages: {
    boundedBy:
      "Derived document projection replaced or deleted with its source.",
  },
  case_law_corpus_upload_intents: {
    boundedBy:
      "At most one active reservation per decision, deleted at settlement or by the upload cleanup task.",
  },
  case_law_corpus_pack_refs: {
    boundedBy: "One row per decision pointer, rewritten with the pointer.",
  },
  corpus_index_projection_states: {
    boundedBy: "One row per corpus entity and index generation.",
  },
  user: { boundedBy: "Account lifecycle and authenticated account deletion." },
  session: {
    boundedBy: "Account lifecycle, session expiry, and session revocation.",
  },
  account: { boundedBy: "Cascade-deleted with its account owner." },
  two_factor: {
    boundedBy: "Account-owned configuration deleted with its owner.",
  },
  organization: {
    boundedBy:
      "Organization lifecycle and authenticated organization deletion.",
  },
  member: { boundedBy: "Organization and account membership lifecycle." },
  invitation: {
    boundedBy: "Organization-owned invitations removed with the organization.",
  },
  jwks: { boundedBy: "Server-managed signing key rotation." },
  apikey: {
    boundedBy: "Authenticated account-owned key creation and revocation.",
  },
  oauth_resource: { boundedBy: "Server-managed resource configuration." },
  oauth_access_token: {
    boundedBy:
      "Client and account lifecycle; issuance requires authorized credentials.",
  },
  oauth_refresh_token: {
    boundedBy:
      "Client and account lifecycle; issuance requires authorized credentials.",
  },
  oauth_consent: {
    boundedBy: "Authenticated account-owned consent and revocation.",
  },
} as const satisfies Record<string, TableRetention>;

export const tableRetention = (table: string): TableRetention | undefined => {
  const declarations: Readonly<Record<string, TableRetention>> =
    TABLE_RETENTION;
  return declarations[table];
};
