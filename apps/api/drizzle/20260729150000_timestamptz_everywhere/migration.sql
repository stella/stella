-- Convert every naive `timestamp` column to `timestamptz`.
--
-- A naive timestamp stores no UTC anchoring, so its meaning silently depends
-- on the writer's session time zone. The session time zone is deliberately
-- NOT pinned here: application pools never set one, so every historical
-- value was written as wall-clock time in the SERVER'S default TimeZone,
-- and the implicit timestamp -> timestamptz conversion below interprets it
-- in that same zone, preserving the original instants on any deployment.
--
-- On servers whose default TimeZone is UTC (managed deployments here),
-- PostgreSQL treats the conversion as binary-compatible and skips the table
-- rewrite (verified: relfilenodes unchanged). Btree indexes keyed on a
-- converted column ARE still rebuilt (the opclass changes), so a converted
-- table holds ACCESS EXCLUSIVE for the duration of its index rebuilds.
-- A self-hosted server with a non-UTC default pays a full table rewrite
-- instead, and values in that zone's ambiguous DST fall-back hour resolve
-- to PostgreSQL's deterministic offset choice; raise statement_timeout
-- before running if very large tables need more than the 20 minutes below.
--
-- Known limitation on non-UTC servers: naive columns could historically mix
-- two provenances — SQL defaults (now()) stored server-local wall clock,
-- while driver-serialized JS Dates stored UTC wall clock. No single
-- conversion zone is correct for both; that ambiguity is inherent to the
-- naive data (and is exactly what this migration ends). The server zone is
-- used because it matches the SQL-generated population; operators who know
-- their data is driver-dominated can SET TIME ZONE 'UTC' for the run.
--
-- The conversion runs in BOUNDED transactions, not the migrator's single
-- transaction: the initial COMMIT below ends the migrator transaction (same
-- split as 20260603120000_case_law_public_slugs), the "user" and "entities"
-- groups run as small explicit transactions, and every remaining ALTER
-- autocommits on its own. One accumulated transaction would retain every
-- table's ACCESS EXCLUSIVE lock until the final commit, leaving
-- request-critical tables unavailable for the whole 108-table run instead of
-- each table's own rebuild. The session-level SETs survive the commits.
--
-- Every statement is re-runnable: a failure partway leaves earlier tables
-- converted and the migration unrecorded; the retry re-executes no-op ALTERs
-- (timestamptz -> timestamptz) and the IF EXISTS + recreate groups converge.
--
-- The `auth_user_select` policy references "user".deleted_at, and PostgreSQL
-- refuses to alter the type of a column used in a policy definition, so the
-- policy is dropped and recreated verbatim (definition copied from
-- 20260710173000_scalable_workspace_authorization) around the "user" ALTER,
-- inside one bounded transaction so the policy is never missing outside it.
--
-- entities_ws_updated_at_coalesce_id_idx embeds a naive-timestamp literal in
-- its COALESCE expression; after the column becomes timestamptz that
-- expression is no longer IMMUTABLE, so the automatic index re-creation the
-- ALTER performs would fail. Drop it and recreate it with a timestamptz
-- literal in one bounded transaction (the ALTER already holds ACCESS
-- EXCLUSIVE on entities there, so a concurrent build is impossible anyway).
--
-- stella-migration-safety: reviewed destructive-change - column type change timestamp -> timestamptz interprets stored values in the server's default TimeZone, the same zone every unpinned writer session used, so instants are preserved on any deployment (binary-compatible, no rewrite, on UTC servers); old application code reads timestamptz transparently, so a partial or failed run needs no schema rollback, and every statement is idempotent for retry; the dropped auth_user_select policy is recreated in the same bounded transaction, and the dropped entities coalesce index is recreated in its own bounded transaction.

-- Statement-level robustness and transaction-control warnings are ignored
-- file-wide: the bounded-transaction layout above is deliberate, and every
-- statement is idempotent for retry as documented. require-timeout-settings
-- is ignored because statement_timeout IS configured below, inside a DO
-- block (conditional, so an operator-raised session value is honored),
-- where the rule cannot see it.
-- squawk-ignore-file prefer-robust-stmts, transaction-nesting, ban-uncommitted-transaction, require-timeout-settings

-- Fail fast instead of queueing behind long-running queries (an ALTER waiting
-- on ACCESS EXCLUSIVE blocks every later reader), but leave the large-table
-- index rebuilds room to finish. Session-level: survives the COMMITs below.
SET lock_timeout = '10s';--> statement-breakpoint

-- Give rebuilds at least 20 minutes, but never lower an operator-raised or
-- disabled (0) session/server value: pg_settings reports the current value
-- in milliseconds regardless of the unit it was set with.
DO $$
DECLARE current_ms integer;
BEGIN
  SELECT setting::integer INTO current_ms
  FROM pg_settings WHERE name = 'statement_timeout';
  IF current_ms <> 0 AND current_ms < 1200000 THEN
    PERFORM set_config('statement_timeout', '20min', false);
  END IF;
END
$$;--> statement-breakpoint

-- End the migrator's wrapping transaction so each conversion below holds its
-- locks only for its own duration.
COMMIT;--> statement-breakpoint

BEGIN;--> statement-breakpoint

DROP POLICY IF EXISTS "auth_user_select" ON "user";--> statement-breakpoint

ALTER TABLE "user"
  ALTER COLUMN "deleted_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

CREATE POLICY "auth_user_select" ON "user" AS PERMISSIVE FOR SELECT TO "stella" USING (
  id = (SELECT current_setting('app.user_id', true))
  OR EXISTS (
    SELECT 1
    FROM member m
    WHERE m.user_id = "user".id
      AND m.organization_id = (
        SELECT current_setting('app.organization_id', true)
      )
  )
  OR (
    "user".deleted_at IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM task_assignees ta
        JOIN workspaces w ON w.id = ta.workspace_id
        WHERE ta.user_id = "user".id
          AND (
            CASE
              WHEN ta.workspace_id = ANY(
                COALESCE(
                  NULLIF(
                    (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                    ''
                  )::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              THEN true
              ELSE ta.workspace_id IN (
                SELECT aw.authorized_workspace_id
                FROM public.stella_authorized_workspaces aw
              )
            END
          )
          AND w.organization_id = (
            SELECT current_setting('app.organization_id', true)
          )
      )
      OR EXISTS (
        SELECT 1
        FROM entities e
        JOIN workspaces w ON w.id = e.workspace_id
        WHERE (e.created_by = "user".id OR e.last_edited_by = "user".id)
          AND (
            CASE
              WHEN e.workspace_id = ANY(
                COALESCE(
                  NULLIF(
                    (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                    ''
                  )::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              THEN true
              ELSE e.workspace_id IN (
                SELECT aw.authorized_workspace_id
                FROM public.stella_authorized_workspaces aw
              )
            END
          )
          AND w.organization_id = (
            SELECT current_setting('app.organization_id', true)
          )
      )
    )
  )
);--> statement-breakpoint

COMMIT;--> statement-breakpoint

BEGIN;--> statement-breakpoint

-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS "entities_ws_updated_at_coalesce_id_idx";--> statement-breakpoint

ALTER TABLE "entities"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "entities_ws_updated_at_coalesce_id_idx"
  ON "entities" ("workspace_id", (COALESCE("updated_at", '0001-01-01 00:00:00+00'::timestamptz)), "id");--> statement-breakpoint

COMMIT;--> statement-breakpoint

ALTER TABLE "account"
  ALTER COLUMN "access_token_expires_at" TYPE timestamptz,
  ALTER COLUMN "refresh_token_expires_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "account_deletion_requests"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz,
  ALTER COLUMN "completed_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "agent_assertion_replay"
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "agent_delegation"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "agent_registration"
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "last_polled_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "agent_skill_resources"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "agent_skills"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "agent_trusted_issuer"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "anonymization_allowlist_entries"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "anonymization_blacklist_entries"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "apikey"
  ALTER COLUMN "last_refill_at" TYPE timestamptz,
  ALTER COLUMN "last_request" TYPE timestamptz,
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "audit_logs"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "billing_codes"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "case_law_citations"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "case_law_court_weights"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "case_law_decisions"
  ALTER COLUMN "document_fetch_requested_at" TYPE timestamptz,
  ALTER COLUMN "document_fetch_attempted_at" TYPE timestamptz,
  ALTER COLUMN "citation_authority_computed_at" TYPE timestamptz,
  ALTER COLUMN "indexed_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "case_law_index_jobs"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "case_law_ingestion_events"
  ALTER COLUMN "started_at" TYPE timestamptz,
  ALTER COLUMN "finished_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "case_law_ingestion_failures"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "case_law_matter_links"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "case_law_polarity_rules"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "case_law_search_documents"
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "case_law_sources"
  ALTER COLUMN "last_sync_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "cell_metadata"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "chat_message_search_documents"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "chat_messages"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "chat_thread_compactions"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "chat_thread_search_documents"
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "chat_threads"
  ALTER COLUMN "recap_generated_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "clause_categories"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "clause_variants"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "clause_versions"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "clauses"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "contact_relationships"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "contact_search_documents"
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "contacts"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "desktop_edit_handoffs"
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "consumed_at" TYPE timestamptz,
  ALTER COLUMN "opened_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "desktop_edit_sessions"
  ALTER COLUMN "checkpoint_updated_at" TYPE timestamptz,
  ALTER COLUMN "token_expires_at" TYPE timestamptz,
  ALTER COLUMN "takeover_requested_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz,
  ALTER COLUMN "closed_at" TYPE timestamptz,
  ALTER COLUMN "expiry_notification_published_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "document_types"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "docx_suggestions"
  ALTER COLUMN "resolved_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "entity_links"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "entity_version_ai_summaries"
  ALTER COLUMN "generated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "entity_versions"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "deleted_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "expenses"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "extracted_content"
  ALTER COLUMN "extracted_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "extraction_runs"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "file_chat_threads"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "flow_definitions"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "flow_runs"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "folio_collab_session_tokens"
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "folio_collab_sessions"
  ALTER COLUMN "yjs_snapshot_updated_at" TYPE timestamptz,
  ALTER COLUMN "docx_checkpoint_updated_at" TYPE timestamptz,
  ALTER COLUMN "seed_claimed_at" TYPE timestamptz,
  ALTER COLUMN "seeded_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz,
  ALTER COLUMN "closed_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "infosoud_tracked_cases"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "invitation"
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "invoices"
  ALTER COLUMN "paid_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "jwks"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "expires_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "legislation_documents"
  ALTER COLUMN "citation_authority_computed_at" TYPE timestamptz,
  ALTER COLUMN "indexed_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "legislation_index_jobs"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "legislation_search_documents"
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "legislation_sources"
  ALTER COLUMN "last_sync_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "mcp_connectors"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "mcp_oauth_clients"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "mcp_oauth_state"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "mcp_user_connections"
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "cached_tools_refreshed_at" TYPE timestamptz,
  ALTER COLUMN "last_used_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "member"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "oauth_access_token"
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "oauth_client"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "oauth_consent"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "oauth_refresh_token"
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "revoked" TYPE timestamptz,
  ALTER COLUMN "auth_time" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "organization"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "organization_settings"
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "pending_uploads"
  ALTER COLUMN "claimed_at" TYPE timestamptz,
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "finalized_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "playbook_definition_versions"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "playbook_definitions"
  ALTER COLUMN "approved_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "properties"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "rate_entries"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "rate_tables"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "report_exports"
  ALTER COLUMN "notification_attempted_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "saved_searches"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "scheduler_jobs"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "search_documents"
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "session"
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "sharepoint_connections"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "sharepoint_oauth_state"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "style_sets"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz,
  ALTER COLUMN "deleted_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "task_assignees"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "template_categories"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "template_chat_threads"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "template_clauses"
  ALTER COLUMN "inserted_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "template_fills"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "template_recipes"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "template_versions"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "templates"
  ALTER COLUMN "last_used_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "time_entries"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "two_factor"
  ALTER COLUMN "locked_until" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "usage_allocations"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "usage_entitlements"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "usage_events"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "usage_policies"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "user_files"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "verification"
  ALTER COLUMN "expires_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "workspace_contacts"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "workspace_members"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "workspace_search_documents"
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "workspace_view_templates"
  ALTER COLUMN "created_at" TYPE timestamptz,
  ALTER COLUMN "updated_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "workspace_views"
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

ALTER TABLE "workspaces"
  ALTER COLUMN "last_activity_at" TYPE timestamptz,
  ALTER COLUMN "created_at" TYPE timestamptz;--> statement-breakpoint

-- ALTER COLUMN ... TYPE discards the column's planner statistics even on
-- the no-rewrite path, so hot range and keyset queries would run on default
-- selectivity until autovacuum re-analyzes. Rebuild statistics for exactly
-- the converted columns; each ANALYZE autocommits and takes only
-- SHARE UPDATE EXCLUSIVE, so it does not block reads or writes. Waiting on
-- that lock does not queue user traffic either, so the fail-fast 10s bound
-- chosen for the ACCESS EXCLUSIVE phase would only turn a harmless wait
-- (e.g. behind autovacuum on the same table) into a spurious deploy retry:
-- give the statistics phase a generous timeout instead.
SET lock_timeout = '5min';--> statement-breakpoint

ANALYZE "account" ("access_token_expires_at", "refresh_token_expires_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "account_deletion_requests" ("created_at", "updated_at", "completed_at");--> statement-breakpoint

ANALYZE "agent_assertion_replay" ("expires_at", "created_at");--> statement-breakpoint

ANALYZE "agent_delegation" ("created_at");--> statement-breakpoint

ANALYZE "agent_registration" ("expires_at", "last_polled_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "agent_skill_resources" ("created_at");--> statement-breakpoint

ANALYZE "agent_skills" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "agent_trusted_issuer" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "anonymization_allowlist_entries" ("created_at");--> statement-breakpoint

ANALYZE "anonymization_blacklist_entries" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "apikey" ("last_refill_at", "last_request", "expires_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "audit_logs" ("created_at");--> statement-breakpoint

ANALYZE "billing_codes" ("created_at");--> statement-breakpoint

ANALYZE "case_law_citations" ("created_at");--> statement-breakpoint

ANALYZE "case_law_court_weights" ("created_at");--> statement-breakpoint

ANALYZE "case_law_decisions" ("document_fetch_requested_at", "document_fetch_attempted_at", "citation_authority_computed_at", "indexed_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "case_law_index_jobs" ("created_at");--> statement-breakpoint

ANALYZE "case_law_ingestion_events" ("started_at", "finished_at");--> statement-breakpoint

ANALYZE "case_law_ingestion_failures" ("created_at");--> statement-breakpoint

ANALYZE "case_law_matter_links" ("created_at");--> statement-breakpoint

ANALYZE "case_law_polarity_rules" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "case_law_search_documents" ("updated_at");--> statement-breakpoint

ANALYZE "case_law_sources" ("last_sync_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "cell_metadata" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "chat_message_search_documents" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "chat_messages" ("created_at");--> statement-breakpoint

ANALYZE "chat_thread_compactions" ("created_at");--> statement-breakpoint

ANALYZE "chat_thread_search_documents" ("updated_at");--> statement-breakpoint

ANALYZE "chat_threads" ("recap_generated_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "clause_categories" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "clause_variants" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "clause_versions" ("created_at");--> statement-breakpoint

ANALYZE "clauses" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "contact_relationships" ("created_at");--> statement-breakpoint

ANALYZE "contact_search_documents" ("updated_at");--> statement-breakpoint

ANALYZE "contacts" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "desktop_edit_handoffs" ("expires_at", "consumed_at", "opened_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "desktop_edit_sessions" ("checkpoint_updated_at", "token_expires_at", "takeover_requested_at", "created_at", "updated_at", "closed_at", "expiry_notification_published_at");--> statement-breakpoint

ANALYZE "document_types" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "docx_suggestions" ("resolved_at", "created_at");--> statement-breakpoint

ANALYZE "entities" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "entity_links" ("created_at");--> statement-breakpoint

ANALYZE "entity_version_ai_summaries" ("generated_at");--> statement-breakpoint

ANALYZE "entity_versions" ("created_at", "deleted_at");--> statement-breakpoint

ANALYZE "expenses" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "extracted_content" ("extracted_at");--> statement-breakpoint

ANALYZE "extraction_runs" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "file_chat_threads" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "flow_definitions" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "flow_runs" ("created_at");--> statement-breakpoint

ANALYZE "folio_collab_session_tokens" ("expires_at", "created_at");--> statement-breakpoint

ANALYZE "folio_collab_sessions" ("yjs_snapshot_updated_at", "docx_checkpoint_updated_at", "seed_claimed_at", "seeded_at", "created_at", "updated_at", "closed_at");--> statement-breakpoint

ANALYZE "infosoud_tracked_cases" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "invitation" ("expires_at", "created_at");--> statement-breakpoint

ANALYZE "invoices" ("paid_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "jwks" ("created_at", "expires_at");--> statement-breakpoint

ANALYZE "legislation_documents" ("citation_authority_computed_at", "indexed_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "legislation_index_jobs" ("created_at");--> statement-breakpoint

ANALYZE "legislation_search_documents" ("updated_at");--> statement-breakpoint

ANALYZE "legislation_sources" ("last_sync_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "mcp_connectors" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "mcp_oauth_clients" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "mcp_oauth_state" ("created_at");--> statement-breakpoint

ANALYZE "mcp_user_connections" ("expires_at", "cached_tools_refreshed_at", "last_used_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "member" ("created_at");--> statement-breakpoint

ANALYZE "oauth_access_token" ("expires_at", "created_at");--> statement-breakpoint

ANALYZE "oauth_client" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "oauth_consent" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "oauth_refresh_token" ("expires_at", "created_at", "revoked", "auth_time");--> statement-breakpoint

ANALYZE "organization" ("created_at");--> statement-breakpoint

ANALYZE "organization_settings" ("updated_at");--> statement-breakpoint

ANALYZE "pending_uploads" ("claimed_at", "expires_at", "created_at", "finalized_at");--> statement-breakpoint

ANALYZE "playbook_definition_versions" ("created_at");--> statement-breakpoint

ANALYZE "playbook_definitions" ("approved_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "properties" ("created_at");--> statement-breakpoint

ANALYZE "rate_entries" ("created_at");--> statement-breakpoint

ANALYZE "rate_tables" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "report_exports" ("notification_attempted_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "saved_searches" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "scheduler_jobs" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "search_documents" ("updated_at");--> statement-breakpoint

ANALYZE "session" ("expires_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "sharepoint_connections" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "sharepoint_oauth_state" ("created_at");--> statement-breakpoint

ANALYZE "style_sets" ("created_at", "updated_at", "deleted_at");--> statement-breakpoint

ANALYZE "task_assignees" ("created_at");--> statement-breakpoint

ANALYZE "template_categories" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "template_chat_threads" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "template_clauses" ("inserted_at");--> statement-breakpoint

ANALYZE "template_fills" ("created_at");--> statement-breakpoint

ANALYZE "template_recipes" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "template_versions" ("created_at");--> statement-breakpoint

ANALYZE "templates" ("last_used_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "time_entries" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "two_factor" ("locked_until");--> statement-breakpoint

ANALYZE "usage_allocations" ("created_at");--> statement-breakpoint

ANALYZE "usage_entitlements" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "usage_events" ("created_at");--> statement-breakpoint

ANALYZE "usage_policies" ("created_at");--> statement-breakpoint

ANALYZE "user" ("deleted_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "user_files" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "verification" ("expires_at", "created_at", "updated_at");--> statement-breakpoint

ANALYZE "workspace_contacts" ("created_at");--> statement-breakpoint

ANALYZE "workspace_members" ("created_at");--> statement-breakpoint

ANALYZE "workspace_search_documents" ("updated_at");--> statement-breakpoint

ANALYZE "workspace_view_templates" ("created_at", "updated_at");--> statement-breakpoint

ANALYZE "workspace_views" ("created_at");--> statement-breakpoint

ANALYZE "workspaces" ("last_activity_at", "created_at");--> statement-breakpoint

-- Reopen a transaction for the migrator's bookkeeping row.
BEGIN;