import type { ENUM_COLUMNS } from "@/api/lib/db/status-tables.gen";

/**
 * What an enum-valued column is to its row. A lifecycle column's moves are
 * constrained (some value may not follow another), so it joins the status
 * inventory and its writes go through the transition owner. An attribute is a
 * fact about the row, including a flag any value of which may follow any other.
 */
export const ENUM_COLUMN_ROLE = {
  lifecycle: "lifecycle",
  attribute: "attribute",
} as const;

export type EnumColumnRole =
  (typeof ENUM_COLUMN_ROLE)[keyof typeof ENUM_COLUMN_ROLE];

const LIFECYCLE = ENUM_COLUMN_ROLE.lifecycle;
const ATTRIBUTE = ENUM_COLUMN_ROLE.attribute;

// Total over every enum-valued table column whose name does not already mark
// it as a lifecycle, keyed by SQL table and column names: a new one fails to
// compile until it is classified here.
type EnumColumnRoles = {
  readonly [TTable in keyof typeof ENUM_COLUMNS]: Readonly<
    Record<(typeof ENUM_COLUMNS)[TTable][number], EnumColumnRole>
  >;
};

export const ENUM_COLUMN_ROLES = {
  account_audit_logs: {
    event_type: ATTRIBUTE,
  },
  account_exports: {
    kind: ATTRIBUTE,
  },
  agent_skills: {
    invocation: ATTRIBUTE,
    origin: ATTRIBUTE,
    scope: ATTRIBUTE,
  },
  ai_memories: {
    kind: ATTRIBUTE,
    scope: ATTRIBUTE,
    source: ATTRIBUTE,
  },
  anonymization_allowlist_entries: {
    entity_feature_gate: ATTRIBUTE,
  },
  audit_logs: {
    activity_category: ATTRIBUTE,
    performer_type: ATTRIBUTE,
    trigger_type: ATTRIBUTE,
  },
  bilingual_translation_rows: {
    disposition: ATTRIBUTE,
    disposition_origin: ATTRIBUTE,
    kind: ATTRIBUTE,
    table_layout: ATTRIBUTE,
  },
  billing_arrangements: {
    mode: ATTRIBUTE,
  },
  billing_codes: {
    type: ATTRIBUTE,
  },
  business_registry_credentials: {
    registry: ATTRIBUTE,
  },
  case_law_analysis_failures: {
    code: ATTRIBUTE,
    key_source: ATTRIBUTE,
  },
  case_law_browse_facet_counts: {
    kind: ATTRIBUTE,
  },
  case_law_citation_doctrine_reviews: {
    doctrinal_treatment: ATTRIBUTE,
    origin: ATTRIBUTE,
  },
  case_law_citation_resolution_census: {
    kind: ATTRIBUTE,
  },
  case_law_citation_reviews: {
    origin: ATTRIBUTE,
  },
  case_law_citations: {
    doctrinal_treatment: ATTRIBUTE,
  },
  case_law_corpus_pack_refs: {
    kind: ATTRIBUTE,
  },
  case_law_corpus_tombstones: {
    reason: ATTRIBUTE,
  },
  case_law_decision_citation_stats: {
    direction: ATTRIBUTE,
    polarity: ATTRIBUTE,
  },
  case_law_decision_judges: {
    role: ATTRIBUTE,
  },
  case_law_decisions: {
    case_number_type: ATTRIBUTE,
  },
  case_law_population_counts: {
    kind: ATTRIBUTE,
  },
  case_law_population_deltas: {
    kind: ATTRIBUTE,
  },
  case_law_population_projections: {
    publication: ATTRIBUTE,
  },
  case_law_provision_citations: {
    applied_version_basis: ATTRIBUTE,
    applied_version_date_relation: ATTRIBUTE,
    selection: ATTRIBUTE,
    span_role: ATTRIBUTE,
    unit: ATTRIBUTE,
    version_evidence_kind: ATTRIBUTE,
    work_source: ATTRIBUTE,
  },
  case_law_provision_extractions: {
    enqueue_reason: ATTRIBUTE,
    lane: ATTRIBUTE,
    outcome: ATTRIBUTE,
    payload_class: ATTRIBUTE,
    terminal_reason: ATTRIBUTE,
  },
  case_law_provision_repair_cursors: {
    name: ATTRIBUTE,
  },
  case_law_provision_scope_transitions: {
    action: ATTRIBUTE,
  },
  case_law_removal_reconciliation_items: {
    kind: ATTRIBUTE,
  },
  case_law_replay_audit_events: {
    action: ATTRIBUTE,
  },
  case_law_replay_batches: {
    failure_code: ATTRIBUTE,
  },
  case_law_replay_blocked: {
    outcome: ATTRIBUTE,
    reason: ATTRIBUTE,
  },
  case_law_research_answers: {
    failure_reason: ATTRIBUTE,
  },
  case_law_sources: {
    ingestion_lease_purpose: ATTRIBUTE,
  },
  case_law_statute_citation_counts: {
    target_type: ATTRIBUTE,
  },
  case_law_statute_citation_memberships: {
    target_type: ATTRIBUTE,
  },
  cell_metadata: {
    entity_feature_gate: ATTRIBUTE,
  },
  chat_content_v3_backfill_receipts: {
    outcome: ATTRIBUTE,
    source: ATTRIBUTE,
  },
  chat_secrets: {
    decision: ATTRIBUTE,
  },
  chat_threads: {
    chat_reasoning_effort: ATTRIBUTE,
  },
  chat_tool_grants: {
    scope: ATTRIBUTE,
  },
  chat_turns: {
    cancellation_reason: ATTRIBUTE,
    failure_code: ATTRIBUTE,
    interaction_type: ATTRIBUTE,
    interruption_reason: ATTRIBUTE,
  },
  // Any recorded decision may replace another (a conflict later waived); the
  // decision path still moves it through the transition owner, with a
  // revision in the predicate.
  conflict_checks: {
    decision: ATTRIBUTE,
    outcome: ATTRIBUTE,
  },
  contact_relationships: {
    relationship_type: ATTRIBUTE,
  },
  contact_search_documents: {
    contact_type: ATTRIBUTE,
  },
  contacts: {
    invoice_language: ATTRIBUTE,
    sanctions_monitoring_mode: ATTRIBUTE,
    time_billing_format: ATTRIBUTE,
    type: ATTRIBUTE,
  },
  corpus_index_generations: {
    family: ATTRIBUTE,
  },
  corpus_index_group_enrollments: {
    contract_version: ATTRIBUTE,
    family: ATTRIBUTE,
  },
  corpus_index_group_withdrawals: {
    family: ATTRIBUTE,
  },
  corpus_index_jurisdiction_serving: {
    family: ATTRIBUTE,
  },
  corpus_index_projection_intents: {
    family: ATTRIBUTE,
  },
  corpus_index_projection_revisions: {
    family: ATTRIBUTE,
  },
  corpus_index_projection_states: {
    append_mode: ATTRIBUTE,
    applied_action: ATTRIBUTE,
    desired_action: ATTRIBUTE,
    family: ATTRIBUTE,
    last_failure_kind: ATTRIBUTE,
  },
  correspondence: {
    channel: ATTRIBUTE,
    direction: ATTRIBUTE,
    dkim: ATTRIBUTE,
    dmarc: ATTRIBUTE,
    entity_feature_gate: ATTRIBUTE,
    intake: ATTRIBUTE,
    source: ATTRIBUTE,
    spf: ATTRIBUTE,
  },
  correspondence_allowed_senders: {
    kind: ATTRIBUTE,
    scope: ATTRIBUTE,
  },
  correspondence_attachments: {
    entity_feature_gate: ATTRIBUTE,
    scan_verdict: ATTRIBUTE,
  },
  correspondence_drop_logs: {
    reason: ATTRIBUTE,
  },
  correspondence_filers: {
    entity_feature_gate: ATTRIBUTE,
  },
  correspondence_sources: {
    entity_feature_gate: ATTRIBUTE,
  },
  desktop_edit_handoffs: {
    entity_feature_gate: ATTRIBUTE,
    failure_reason: ATTRIBUTE,
  },
  desktop_edit_sessions: {
    entity_feature_gate: ATTRIBUTE,
    file_type: ATTRIBUTE,
  },
  desktop_runner_commands: {
    kind: ATTRIBUTE,
  },
  desktop_runner_events: {
    type: ATTRIBUTE,
  },
  desktop_runner_folder_restores: {
    reason: ATTRIBUTE,
  },
  desktop_runner_runs: {
    harness: ATTRIBUTE,
    lost_reason: ATTRIBUTE,
    outcome: ATTRIBUTE,
    reject_reason: ATTRIBUTE,
  },
  desktop_runners: {
    connection: ATTRIBUTE,
  },
  document_processing_runs: {
    entity_feature_gate: ATTRIBUTE,
    kind: ATTRIBUTE,
    request_source: ATTRIBUTE,
  },
  document_review_findings: {
    decision: ATTRIBUTE,
    flags: ATTRIBUTE,
  },
  document_review_parties: {
    entity_feature_gate: ATTRIBUTE,
  },
  document_review_reference_passages: {
    entity_feature_gate: ATTRIBUTE,
  },
  document_review_runs: {
    executor: ATTRIBUTE,
  },
  document_translation_runs: {
    comment_policy: ATTRIBUTE,
    engine: ATTRIBUTE,
    entity_feature_gate: ATTRIBUTE,
    output: ATTRIBUTE,
  },
  document_translation_units: {
    entity_feature_gate: ATTRIBUTE,
  },
  docx_suggestions: {
    applied_mode: ATTRIBUTE,
    entity_feature_gate: ATTRIBUTE,
    severity: ATTRIBUTE,
  },
  entities: {
    agenda_kind: ATTRIBUTE,
    agenda_source: ATTRIBUTE,
    availability: ATTRIBUTE,
    entity_feature_gate: ATTRIBUTE,
    kind: ATTRIBUTE,
    list_item_type: ATTRIBUTE,
    sensitivity: ATTRIBUTE,
  },
  entity_links: {
    entity_feature_gate: ATTRIBUTE,
  },
  entity_version_ai_summaries: {
    entity_feature_gate: ATTRIBUTE,
  },
  entity_versions: {
    entity_feature_gate: ATTRIBUTE,
  },
  eu_completion_receipts: {
    mode: ATTRIBUTE,
    target: ATTRIBUTE,
  },
  expenses: {
    category: ATTRIBUTE,
  },
  extracted_content: {
    entity_feature_gate: ATTRIBUTE,
  },
  extraction_runs: {
    scope: ATTRIBUTE,
  },
  feature_enrolments: {
    feature_id: ATTRIBUTE,
  },
  feedback_reports: {
    area: ATTRIBUTE,
    kind: ATTRIBUTE,
    via: ATTRIBUTE,
  },
  fields: {
    entity_feature_gate: ATTRIBUTE,
  },
  file_chat_threads: {
    entity_feature_gate: ATTRIBUTE,
  },
  file_comparison_uploads: {
    kind: ATTRIBUTE,
  },
  flow_run_steps: {
    entity_feature_gate: ATTRIBUTE,
  },
  folio_collab_contributions: {
    entity_feature_gate: ATTRIBUTE,
  },
  folio_collab_publications: {
    entity_feature_gate: ATTRIBUTE,
  },
  folio_collab_room_tokens: {
    entity_feature_gate: ATTRIBUTE,
  },
  folio_collab_rooms: {
    entity_feature_gate: ATTRIBUTE,
  },
  invoice_lines: {
    billing_purpose: ATTRIBUTE,
    source: ATTRIBUTE,
    vat_treatment: ATTRIBUTE,
  },
  invoice_payments: {
    method: ATTRIBUTE,
    origin: ATTRIBUTE,
  },
  invoices: {
    billing_mode: ATTRIBUTE,
    document_type: ATTRIBUTE,
    language: ATTRIBUTE,
  },
  justifications: {
    entity_feature_gate: ATTRIBUTE,
  },
  legal_graph_edges: {
    confidence: ATTRIBUTE,
    entity_feature_gate: ATTRIBUTE,
    from_kind: ATTRIBUTE,
    kind: ATTRIBUTE,
    producer_kind: ATTRIBUTE,
    stance: ATTRIBUTE,
    to_kind: ATTRIBUTE,
  },
  // Whether a hold covers a matter or one item: fixed when it is placed.
  legal_holds: {
    scope_type: ATTRIBUTE,
  },
  legal_list_claim_carry_outcomes: {
    entity_feature_gate: ATTRIBUTE,
    outcome: ATTRIBUTE,
  },
  legal_list_claim_review_events: {
    entity_feature_gate: ATTRIBUTE,
    kind: ATTRIBUTE,
  },
  legal_list_claims: {
    asserted_on_precision: ATTRIBUTE,
    // Where a claim's date came from; `pending` only marks a row the backfill
    // has yet to read, not a step a claim moves through.
    asserted_on_source: ATTRIBUTE,
    entity_feature_gate: ATTRIBUTE,
    framing: ATTRIBUTE,
    type: ATTRIBUTE,
  },
  legal_list_fact_details: {
    confidence: ATTRIBUTE,
    entity_feature_gate: ATTRIBUTE,
    occurred_on_precision: ATTRIBUTE,
    scoring: ATTRIBUTE,
  },
  legal_list_generation_candidate_sources: {
    entity_feature_gate: ATTRIBUTE,
  },
  legal_list_generation_candidates: {
    confidence: ATTRIBUTE,
    entity_feature_gate: ATTRIBUTE,
    item_type: ATTRIBUTE,
    occurred_on_precision: ATTRIBUTE,
    priority: ATTRIBUTE,
    scoring: ATTRIBUTE,
  },
  legal_list_generation_runs: {
    error_code: ATTRIBUTE,
    item_type: ATTRIBUTE,
    producer: ATTRIBUTE,
  },
  legal_list_generation_sources: {
    entity_feature_gate: ATTRIBUTE,
  },
  legal_list_item_comments: {
    entity_feature_gate: ATTRIBUTE,
  },
  legal_list_item_reviews: {
    decision: ATTRIBUTE,
    entity_feature_gate: ATTRIBUTE,
  },
  legal_list_item_source_decisions: {
    entity_feature_gate: ATTRIBUTE,
  },
  legal_list_item_sources: {
    entity_feature_gate: ATTRIBUTE,
  },
  legal_list_items: {
    entity_feature_gate: ATTRIBUTE,
  },
  legal_list_source_documents: {
    entity_feature_gate: ATTRIBUTE,
    source_kind: ATTRIBUTE,
  },
  legal_list_verification_blocks: {
    entity_feature_gate: ATTRIBUTE,
    kind: ATTRIBUTE,
  },
  legal_list_verification_read_receipts: {
    entity_feature_gate: ATTRIBUTE,
  },
  legal_list_verification_runs: {
    entity_feature_gate: ATTRIBUTE,
    error_code: ATTRIBUTE,
  },
  legal_reader_annotations: {
    color: ATTRIBUTE,
    kind: ATTRIBUTE,
    style: ATTRIBUTE,
    target_type: ATTRIBUTE,
    visibility: ATTRIBUTE,
  },
  legal_reader_answer_messages: {
    role: ATTRIBUTE,
  },
  legal_reader_answers: {
    kind: ATTRIBUTE,
    visibility: ATTRIBUTE,
  },
  legislation_amendments: {
    change_kind: ATTRIBUTE,
    effective_type: ATTRIBUTE,
  },
  legislation_documents: {
    expression_kind: ATTRIBUTE,
    identity_mode: ATTRIBUTE,
    window_disposition: ATTRIBUTE,
  },
  legislation_sources: {
    identity_mode: ATTRIBUTE,
  },
  legislation_work_names: {
    derivation: ATTRIBUTE,
  },
  mcp_connectors: {
    auth_type: ATTRIBUTE,
  },
  mcp_user_connections: {
    response_disposition: ATTRIBUTE,
  },
  mcp_web_handoff: {
    kind: ATTRIBUTE,
  },
  model_run_budgets: {
    run_kind: ATTRIBUTE,
  },
  notifications: {
    entity_type: ATTRIBUTE,
    kind: ATTRIBUTE,
  },
  number_series: {
    document_type: ATTRIBUTE,
  },
  number_series_allocations: {
    document_type: ATTRIBUTE,
  },
  oauth_client: {
    registration_origin: ATTRIBUTE,
  },
  office_file_evidence: {
    entity_feature_gate: ATTRIBUTE,
    format: ATTRIBUTE,
  },
  organization_access_states: {
    origin: ATTRIBUTE,
  },
  organization_data_exports: {
    version_scope: ATTRIBUTE,
  },
  organization_settings: {
    ai_billing_drafts_mode: ATTRIBUTE,
    document_processing_mode: ATTRIBUTE,
    invoice_language: ATTRIBUTE,
    local_run_max_approval_mode: ATTRIBUTE,
    managed_ai_residency: ATTRIBUTE,
    personal_api_key_policy: ATTRIBUTE,
    sanctions_monitoring_mode: ATTRIBUTE,
  },
  pdf_signing_sessions: {
    close_reason: ATTRIBUTE,
    entity_feature_gate: ATTRIBUTE,
    key_type: ATTRIBUTE,
  },
  pending_uploads: {
    purpose: ATTRIBUTE,
  },
  push_devices: {
    bundle_id: ATTRIBUTE,
    environment: ATTRIBUTE,
  },
  rate_entries: {
    role: ATTRIBUTE,
  },
  registration_daily_budget: {
    kind: ATTRIBUTE,
  },
  report_exports: {
    entity_feature_gate: ATTRIBUTE,
    format: ATTRIBUTE,
    mode: ATTRIBUTE,
  },
  sanctions_contact_matches: {
    disposition: ATTRIBUTE,
  },
  sanctions_editions: {
    guard_code: ATTRIBUTE,
  },
  sanctions_screening_events: {
    type: ATTRIBUTE,
  },
  sanctions_sources: {
    held_guard_code: ATTRIBUTE,
    last_failure_code: ATTRIBUTE,
  },
  search_document_preview_passages: {
    entity_feature_gate: ATTRIBUTE,
  },
  search_documents: {
    entity_feature_gate: ATTRIBUTE,
    kind: ATTRIBUTE,
  },
  search_history_entries: {
    kind: ATTRIBUTE,
  },
  search_history_tombstones: {
    kind: ATTRIBUTE,
  },
  search_projection_repair_queue: {
    kind: ATTRIBUTE,
  },
  session: {
    refresh_mode: ATTRIBUTE,
  },
  signal_events: {
    type: ATTRIBUTE,
  },
  signals: {
    kind: ATTRIBUTE,
    origin: ATTRIBUTE,
    severity: ATTRIBUTE,
  },
  soft_law_document_versions: {
    extraction_quality: ATTRIBUTE,
  },
  soft_law_documents: {
    kind: ATTRIBUTE,
    validity_basis: ATTRIBUTE,
  },
  soft_law_ingestion_attempts: {
    tag: ATTRIBUTE,
  },
  soft_law_sources: {
    failure_tag: ATTRIBUTE,
  },
  task_assignees: {
    entity_feature_gate: ATTRIBUTE,
    role: ATTRIBUTE,
  },
  template_lookup_format_user_defaults: {
    registry: ATTRIBUTE,
  },
  template_lookup_formats: {
    preference: ATTRIBUTE,
    registry: ATTRIBUTE,
  },
  templates: {
    kind: ATTRIBUTE,
    origin_type: ATTRIBUTE,
  },
  time_entries: {
    activity_group: ATTRIBUTE,
    invoice_attachment: ATTRIBUTE,
    source: ATTRIBUTE,
  },
  timer_activity_devices: {
    bundle_id: ATTRIBUTE,
    environment: ATTRIBUTE,
  },
  usage_allocations: {
    reason: ATTRIBUTE,
    source_type: ATTRIBUTE,
  },
  usage_entitlements: {
    source: ATTRIBUTE,
  },
  usage_events: {
    action_type: ATTRIBUTE,
    lane: ATTRIBUTE,
    service_tier: ATTRIBUTE,
  },
  usage_lane_counters: {
    kind: ATTRIBUTE,
  },
  usage_policies: {
    billing_interval: ATTRIBUTE,
    kind: ATTRIBUTE,
    price_basis: ATTRIBUTE,
    visibility: ATTRIBUTE,
  },
  usage_provider_webhook_events: {
    result: LIFECYCLE,
  },
  user: {
    reader_answer_language: ATTRIBUTE,
  },
  user_professional_use_acceptances: {
    source: ATTRIBUTE,
  },
  work_obligation_events: {
    entity_feature_gate: ATTRIBUTE,
    type: ATTRIBUTE,
  },
  work_obligations: {
    entity_feature_gate: ATTRIBUTE,
    source_type: ATTRIBUTE,
    type: ATTRIBUTE,
  },
  workspace_contacts: {
    role: ATTRIBUTE,
  },
} as const satisfies EnumColumnRoles;
