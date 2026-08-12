SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Re-render the four time_entries policies in the canonical form.
--
-- 20260809120000 wrote them by hand as `(x = ANY(...) OR x IN (...)) AND org`.
-- 20260812110000 then aligned every other org-pinned table on the rendering
-- that wsOrganizationPolicies() in apps/api/src/db/rls.ts actually produces,
-- which is `CASE ... END AND org`. The two predicates decide identically and
-- always have; they differ only in text.
--
-- That difference is the point. A policy body no generator produces has to be
-- re-derived by hand every time the catalog is compared against the
-- declarative model, and a reviewer holding two spellings of one rule in mind
-- eventually stops checking either. time_entries was the last table still
-- carrying the hand-written spelling.
--
-- The statements below are the 20260812110000 rendering with the table name
-- substituted, so the catalog text becomes byte-identical to its siblings and
-- to what drizzle emits from the schema.

-- stella-migration-safety: reviewed destructive-change - each of the four policies is dropped and immediately recreated under the same name, in the same transaction, with a predicate that is logically identical to the one it replaces; time_entries is never left without a policy and no request can observe a different authorization outcome. Rollback restores the prior text with the matching application revision.

DROP POLICY "time_entries_workspace_select" ON "time_entries";--> statement-breakpoint
DROP POLICY "time_entries_workspace_insert" ON "time_entries";--> statement-breakpoint
DROP POLICY "time_entries_workspace_update" ON "time_entries";--> statement-breakpoint
DROP POLICY "time_entries_workspace_delete" ON "time_entries";--> statement-breakpoint
CREATE POLICY "time_entries_workspace_select"
  ON "time_entries" AS PERMISSIVE FOR SELECT TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "time_entries_workspace_insert"
  ON "time_entries" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "time_entries_workspace_update"
  ON "time_entries" AS PERMISSIVE FOR UPDATE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "time_entries_workspace_delete"
  ON "time_entries" AS PERMISSIVE FOR DELETE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));
