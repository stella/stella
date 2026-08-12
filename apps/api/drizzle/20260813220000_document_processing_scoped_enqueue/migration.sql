SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Let the transaction that commits an uploaded file also commit the durable
-- request to extract its text.
--
-- 20260730100000 gave document_processing_runs the read-only shape: SELECT for
-- the tenant, RESTRICTIVE `false` for INSERT/UPDATE/DELETE, with every row
-- written by the root worker. The request insert therefore had to run after the
-- caller's transaction committed, and a crash in that window dropped the
-- request entirely: recovery fell to the bounded repair scan over the corpus
-- instead of the queued-run dispatcher.
--
-- The blanket INSERT denial is replaced by a permissive INSERT policy whose
-- WITH CHECK pins the same workspace and organization scopes the SELECT policy
-- uses, plus the exact enqueue shape:
--
--   kind = 'native-extraction' AND request_source = 'upload'
--   AND status = 'queued' AND requested_by IS NULL AND attempt_count = 0
--   AND processor_version = 1
--
-- `processor_version` is pinned because it participates in
-- document_processing_runs_source_uidx, the conflict identity that makes
-- re-requesting the same source a no-op. Left free (its only constraint is
-- `> 0`), a scoped session could walk it and mint unlimited distinct,
-- dispatchable runs for one file. The cost is that bumping the native
-- extraction contract's version needs a migration; a schema test fails when
-- the constant and this policy disagree, so that lands as a red test rather
-- than as inserts denied in production.
--
-- so the scoped role can create only a fresh, unattributed, upload-sourced
-- native-extraction request for a workspace it already holds. OCR runs (which
-- spend external processing budget), manual and repair requests, and every
-- state transition after the insert stay root-writer only: the RESTRICTIVE
-- UPDATE and DELETE denials are untouched, so a tenant cannot advance, retry,
-- re-attribute, or delete the row it requested. Table privileges are unchanged.
--
-- Precedent: entity_deletion_cleanup_insert (20260730140000), where the delete
-- request creates its outbox row through its own scoped transaction.
--
-- The predicate below is the exact rendering of
-- wsOrganizationScopedRequestPolicies() from apps/api/src/db/rls.ts with
-- document_processing.ts's shape check, so drizzle's declarative model and the
-- live catalog agree and db:push reports no drift.

-- stella-migration-safety: reviewed destructive-change - the restrictive INSERT denial is dropped and immediately replaced, in the same transaction, by a narrower permissive INSERT policy; the table is never left accepting an unscoped insert, and SELECT/UPDATE/DELETE authorization is unchanged. Rollback recreates the restrictive policy with the matching application revision.

DROP POLICY "document_processing_runs_no_insert"
  ON "document_processing_runs";--> statement-breakpoint
CREATE POLICY "document_processing_runs_native_extraction_insert"
  ON "document_processing_runs" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (((
    CASE
    WHEN workspace_id = ANY(
      COALESCE(
        NULLIF(
          (SELECT pg_catalog.current_setting(
            'app.workspace_ids', true
          )),
          ''
        )::uuid[],
        ARRAY[]::uuid[]
      )
    )
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END AND organization_id =
    (SELECT current_setting(
      'app.organization_id', true
    ))
  ) AND (
    kind = 'native-extraction'
    AND request_source = 'upload'
    AND status = 'queued'
    AND requested_by IS NULL
    AND attempt_count = 0
    AND processor_version = 1
  )));
