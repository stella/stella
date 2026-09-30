-- Give every existing matter a Correspondence view.
--
-- Correspondence became a view layout (see VIEW_LAYOUT_TYPES in
-- packages/api-contract/src/view-layout.ts): new matters get one at creation
-- (getDefaultViews in src/lib/views.ts), placed last. This backfills the
-- matters created before that, appending the view after each matter's last
-- view. A matter may later remove it; nothing here recreates it.
--
-- Additive and idempotent: the NOT EXISTS guard skips every matter that
-- already holds a correspondence view, so a retried run inserts nothing and
-- no existing row is touched. Matters being deleted are skipped.
--
-- The name is stored in the source language ("en") and re-localized on read
-- (localizeDefaultViewName), like the other default views. Keep the layout in
-- parity with emptyLayout("correspondence") in src/lib/views.ts.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
-- stella-migration-safety: reviewed insert-select - inserts at most one small row per matter, only for matters without a correspondence view (NOT EXISTS makes a replay insert nothing); it reads workspaces and the per-matter workspace_views position index and changes no existing row. Rollback: the rows are ordinary removable views, so deleting the correspondence views reverts it.
INSERT INTO "workspace_views" ("id", "workspace_id", "name", "layout", "position")
SELECT
  gen_random_uuid(),
  w."id",
  'Correspondence',
  jsonb_build_object(
    'version', 1,
    'type', 'correspondence',
    'filters', '[]'::jsonb,
    'sorts', '[]'::jsonb,
    'hiddenProperties', '[]'::jsonb,
    'calculations', '[]'::jsonb
  ),
  COALESCE(
    (
      SELECT MAX(v."position")
      FROM "workspace_views" v
      WHERE v."workspace_id" = w."id"
    ),
    -1
  ) + 1
FROM "workspaces" w
WHERE w."status" <> 'deleting'
  AND NOT EXISTS (
    SELECT 1
    FROM "workspace_views" v
    WHERE v."workspace_id" = w."id"
      AND v."layout" ->> 'type' = 'correspondence'
  );
