// Frozen legacy baseline. Entries may shrink; new FORCE-RLS tables require
// the canonical owner policy. Operation sets declare intent, not new grants.
export const FORCE_RLS_OWNER_ALLOWLIST = {
  account_audit_logs: {
    ownerAccess: "reviewed",
    declaredOperations: "insert+select",
    intent: "append-only audit history prohibits owner update/delete",
    source:
      "apps/api/drizzle/20261010005100_account_audit_scope/migration.sql:18",
  },
  billing_arrangements: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; insert to stella; update to stella; delete to stella",
    source: "apps/api/drizzle/20261003122900_billing_modes/migration.sql:37",
  },
  case_law_court_directory_ranks: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20260929184000_case_law_court_directory_ranks/migration.sql:20",
  },
  case_law_decision_aliases: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. all to stella_ingestion",
    source:
      "apps/api/drizzle/20261003123000_case_law_decision_aliases/migration.sql:16",
  },
  case_law_decision_citation_stats: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; all to stella_ingestion; select to stella_public_law_reader",
    source:
      "apps/api/drizzle/20261005120200_decision_citation_stats/migration.sql:248",
  },
  case_law_decision_citation_stats_state: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; all to stella_ingestion; select to stella_public_law_reader",
    source:
      "apps/api/drizzle/20261005120200_decision_citation_stats/migration.sql:257",
  },
  case_law_provision_admission: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20260926170000_case_law_provision_backfill/migration.sql:34",
  },
  case_law_provision_extraction_revisions: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20260926160000_case_law_provision_extraction_state/migration.sql:309",
  },
  case_law_provision_extraction_revisions_registry: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20260926160000_case_law_provision_extraction_state/migration.sql:306",
  },
  case_law_provision_extraction_scopes: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20260926160000_case_law_provision_extraction_state/migration.sql:300",
  },
  case_law_provision_extractions: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20260926160000_case_law_provision_extraction_state/migration.sql:312",
  },
  case_law_provision_repair_cursors: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20260926170000_case_law_provision_backfill/migration.sql:17",
  },
  case_law_provision_scope_transitions: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20260926160000_case_law_provision_extraction_state/migration.sql:303",
  },
  case_law_replay_audit_events: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "all; all; equivalent statement-constant initplan owner predicate introduced by ALTER POLICY; automatic guard intentionally rejects noncanonical spelling",
    source:
      "apps/api/drizzle/20261010212000_replay_owner_policy_plans/migration.sql:26",
  },
  case_law_replay_batches: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "all; all; equivalent statement-constant initplan owner predicate introduced by ALTER POLICY; automatic guard intentionally rejects noncanonical spelling",
    source:
      "apps/api/drizzle/20261010212000_replay_owner_policy_plans/migration.sql:6",
  },
  case_law_replay_blocked: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "all; all; equivalent statement-constant initplan owner predicate introduced by ALTER POLICY; automatic guard intentionally rejects noncanonical spelling",
    source:
      "apps/api/drizzle/20261010212000_replay_owner_policy_plans/migration.sql:11",
  },
  case_law_replay_daily_rows: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "all; all; equivalent statement-constant initplan owner predicate introduced by ALTER POLICY; automatic guard intentionally rejects noncanonical spelling",
    source:
      "apps/api/drizzle/20261010212000_replay_owner_policy_plans/migration.sql:16",
  },
  case_law_replay_source_progress: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "all; all; equivalent statement-constant initplan owner predicate introduced by ALTER POLICY; automatic guard intentionally rejects noncanonical spelling",
    source:
      "apps/api/drizzle/20261010212000_replay_owner_policy_plans/migration.sql:21",
  },
  case_law_search_backfill_failures: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. all to "stella_ingestion"',
    source:
      "apps/api/drizzle/20260929153636_case_law_search_backfill_failures/migration.sql:34",
  },
  case_law_sitemap_shards: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20260927230000_case_law_sitemap_shards/migration.sql:23",
  },
  chat_message_revisions: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to "stella"; insert to "stella"',
    source:
      "apps/api/drizzle/20261009190430_chat_message_revisions/migration.sql:34",
  },
  chat_thread_names: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to "stella"; insert to "stella"',
    source:
      "apps/api/drizzle/20260927120000_chat_thread_names/migration.sql:25",
  },
  corpus_index_group_withdrawals: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20261003122800_corpus_index_group_withdrawals/migration.sql:40",
  },
  correspondence: {
    ownerAccess: "reviewed",
    declaredOperations: "select+update+delete",
    intent:
      "Scoped offboarding and review-reset access; preserve existing owner operation limits.",
    source:
      "apps/api/drizzle/20261010194500_review_reset_owner_scope/migration.sql:64",
  },
  correspondence_allowed_sender_matters: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to "stella"; insert to "stella"; update to "stella"; delete to "stella"',
    source:
      "apps/api/drizzle/20260928090000_correspondence_core/migration.sql:203",
  },
  correspondence_allowed_senders: {
    ownerAccess: "reviewed",
    declaredOperations: "select, update, delete",
    intent:
      "select, update, delete; restricted owner predicate/scope; preserve existing operation limits",
    source:
      "apps/api/drizzle/20260928090000_correspondence_core/migration.sql:193",
  },
  correspondence_attachments: {
    ownerAccess: "reviewed",
    declaredOperations: "select, delete",
    intent:
      "select, delete; restricted owner predicate/scope; preserve existing operation limits",
    source:
      "apps/api/drizzle/20261010194500_review_reset_owner_scope/migration.sql:84",
  },
  correspondence_drop_logs: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to "stella"; insert to "stella"; update to "stella"; delete to "stella"',
    source:
      "apps/api/drizzle/20260928090000_correspondence_core/migration.sql:210",
  },
  correspondence_filers: {
    ownerAccess: "reviewed",
    declaredOperations: "select, update, delete",
    intent:
      "select, update, delete; restricted owner predicate/scope; preserve existing operation limits",
    source:
      "apps/api/drizzle/20260928090000_correspondence_core/migration.sql:220",
  },
  desktop_presence: {
    ownerAccess: "reviewed",
    declaredOperations: "select+delete",
    intent: "review-reset owner scope constrains access",
    source:
      "apps/api/drizzle/20261010194500_review_reset_owner_scope/migration.sql:54",
  },
  desktop_time_entry_batches: {
    ownerAccess: "reviewed",
    declaredOperations: "select, delete",
    intent:
      "select, delete; restricted owner predicate/scope; preserve existing operation limits",
    source:
      "apps/api/drizzle/20261009165000_desktop_activity_batch_receipts/migration.sql:26",
  },
  invoice_lines: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to "stella"; insert to "stella"; update to "stella"; delete to "stella"',
    source: "apps/api/drizzle/20261003122200_invoice_lines/migration.sql:74",
  },
  legal_list_claim_review_events: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to stella; insert to stella; update to stella; delete to stella; all to "stella_entity_gate"; all to "stella"',
    source:
      "apps/api/drizzle/20260925220000_legal_list_verifications/migration.sql:210",
  },
  legal_list_claims: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to stella; insert to stella; update to stella; delete to stella; all to "stella_entity_gate"; all to "stella"',
    source:
      "apps/api/drizzle/20260925220000_legal_list_verifications/migration.sql:161",
  },
  legal_list_verification_blocks: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to stella; insert to stella; update to stella; delete to stella; all to "stella_entity_gate"; all to "stella"',
    source:
      "apps/api/drizzle/20260928132500_legal_list_verification_blocks/migration.sql:23",
  },
  legal_list_verification_read_receipts: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to stella; insert to stella; update to stella; delete to stella; all to "stella_entity_gate"; all to "stella"',
    source:
      "apps/api/drizzle/20261005120400_verification_read_receipts/migration.sql:22",
  },
  legal_reader_answer_messages: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; insert to stella; update to stella; delete to stella",
    source: "apps/api/drizzle/20261010212100_reader_answers/migration.sql:78",
  },
  legal_reader_answers: {
    ownerAccess: "reviewed",
    declaredOperations: "select, delete",
    intent:
      "select, delete; restricted owner predicate/scope; preserve existing operation limits",
    source: "apps/api/drizzle/20261010212100_reader_answers/migration.sql:68",
  },
  legislation_amendment_snapshots: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; all to stella_ingestion; select to stella_public_law_reader",
    source:
      "apps/api/drizzle/20261019060000_legislation_amendments/migration.sql:40",
  },
  legislation_amendments: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; all to stella_ingestion; select to stella_public_law_reader",
    source:
      "apps/api/drizzle/20261019060000_legislation_amendments/migration.sql:45",
  },
  legislation_work_changes: {
    ownerAccess: "reviewed",
    declaredOperations: "insert",
    intent:
      "insert; insert only; public WITH CHECK(true), append ledger; ingestion role retains all",
    source:
      "apps/api/drizzle/20260926150000_legislation_payload_revision/migration.sql:27",
  },
  legislation_work_names: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20261003120300_legislation_work_names/migration.sql:47",
  },
  matter_inbound_addresses: {
    ownerAccess: "reviewed",
    declaredOperations: "select",
    intent:
      "select; restricted owner predicate/scope; preserve existing operation limits",
    source:
      "apps/api/drizzle/20260928150200_inbound_token_lookup/migration.sql:4",
  },
  mcp_connector_authorization_reviews: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to "stella"; insert to "stella"; update to "stella"; delete to "stella"',
    source:
      "apps/api/drizzle/20261003124600_mcp_authorization_reviews/migration.sql:25",
  },
  number_series: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; insert to stella; update to stella; delete to stella",
    source: "apps/api/drizzle/20261003122100_number_series/migration.sql:27",
  },
  number_series_allocations: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; insert to stella; update to stella; delete to stella",
    source: "apps/api/drizzle/20261003122100_number_series/migration.sql:63",
  },
  number_series_counters: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; insert to stella; update to stella; delete to stella",
    source: "apps/api/drizzle/20261003122100_number_series/migration.sql:44",
  },
  organization_access_states: {
    ownerAccess: "reviewed",
    declaredOperations: "select+insert+update",
    intent: "owner manages admission state without deletion",
    source:
      "apps/api/drizzle/20260930090000_organization_access_state/migration.sql:27",
  },
  pdf_signing_sessions: {
    ownerAccess: "reviewed",
    declaredOperations: "select, delete",
    intent:
      "select, delete; restricted owner predicate/scope; preserve existing operation limits",
    source:
      "apps/api/drizzle/20260928101000_pdf_signing_sessions/migration.sql:118",
  },
  sanctions_edition_entries: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to "stella"; all to "stella_ingestion"; select to stella_public_sanctions_reader',
    source:
      "apps/api/drizzle/20261003121900_sanctions_sources/migration.sql:135",
  },
  sanctions_edition_fanouts: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; all to stella_ingestion",
    source:
      "apps/api/drizzle/20261003123000_sanctions_monitoring_backfills/migration.sql:34",
  },
  sanctions_editions: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to "stella"; all to "stella_ingestion"; select to stella_public_sanctions_reader',
    source:
      "apps/api/drizzle/20261003121900_sanctions_sources/migration.sql:127",
  },
  sanctions_entry_payloads: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to "stella"; all to "stella_ingestion"; select to stella_public_sanctions_reader',
    source:
      "apps/api/drizzle/20261003121900_sanctions_sources/migration.sql:131",
  },
  sanctions_sources: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      'Scoped role operations are declared; owner access remains unverified. select to "stella"; all to "stella_ingestion"; select to stella_public_sanctions_reader',
    source:
      "apps/api/drizzle/20261003121900_sanctions_sources/migration.sql:123",
  },
  saved_time_narratives: {
    ownerAccess: "reviewed",
    declaredOperations: "select, delete",
    intent:
      "select, delete; restricted owner predicate/scope; preserve existing operation limits",
    source:
      "apps/api/drizzle/20261010194500_review_reset_owner_scope/migration.sql:34",
  },
  seller_profiles: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; insert to stella; update to stella; delete to stella",
    source: "apps/api/drizzle/20261001000000_seller_profiles/migration.sql:36",
  },
  soft_law_document_locators: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. all to stella_ingestion",
    source: "apps/api/drizzle/20261004104100_soft_law_corpus/migration.sql:103",
  },
  soft_law_document_versions: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. all to stella_ingestion",
    source: "apps/api/drizzle/20261004104100_soft_law_corpus/migration.sql:105",
  },
  soft_law_documents: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. all to stella_ingestion",
    source: "apps/api/drizzle/20261004104100_soft_law_corpus/migration.sql:107",
  },
  soft_law_ingestion_attempts: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. all to stella_ingestion",
    source: "apps/api/drizzle/20261004104100_soft_law_corpus/migration.sql:154",
  },
  soft_law_sources: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. all to stella_ingestion",
    source: "apps/api/drizzle/20261004104100_soft_law_corpus/migration.sql:109",
  },
  statute_sitemap_shards: {
    ownerAccess: "reviewed",
    declaredOperations: "all",
    intent:
      "existing grant-controlled TO public USING(true)/WITH CHECK(true) policy permits owner operations; access enforced by table grants",
    source:
      "apps/api/drizzle/20260928165000_statute_sitemap_shards/migration.sql:18",
  },
  time_daily_targets: {
    ownerAccess: "reviewed",
    declaredOperations: "select, delete",
    intent:
      "select, delete; restricted owner predicate/scope; preserve existing operation limits",
    source:
      "apps/api/drizzle/20261010194500_review_reset_owner_scope/migration.sql:4",
  },
  time_entry_timer_states: {
    ownerAccess: "reviewed",
    declaredOperations: "select, delete",
    intent:
      "select, delete; restricted owner predicate/scope; preserve existing operation limits",
    source:
      "apps/api/drizzle/20261010194500_review_reset_owner_scope/migration.sql:44",
  },
  time_timer_confirmations: {
    ownerAccess: "reviewed",
    declaredOperations: "select, delete",
    intent:
      "select, delete; restricted owner predicate/scope; preserve existing operation limits",
    source:
      "apps/api/drizzle/20261010194500_review_reset_owner_scope/migration.sql:24",
  },
  time_timers: {
    ownerAccess: "reviewed",
    declaredOperations: "select, delete",
    intent:
      "select, delete; restricted owner predicate/scope; preserve existing operation limits",
    source:
      "apps/api/drizzle/20261010194500_review_reset_owner_scope/migration.sql:14",
  },
  vat_rates: {
    ownerAccess: "none-declared-unverified",
    declaredOperations: "none-declared",
    intent:
      "Scoped role operations are declared; owner access remains unverified. select to stella; insert to stella; update to stella; delete to stella",
    source: "apps/api/drizzle/20260929200000_vat_rates/migration.sql:23",
  },
} as const;
