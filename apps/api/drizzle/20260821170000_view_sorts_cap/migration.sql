-- stella-migration-safety: reviewed bulk-backfill - each UPDATE is bounded by a WHERE clause matching only rows whose layout->'sorts' array exceeds the cap (normally none), on per-workspace layout tables whose row counts are small, and the new value is computed per-row from the row's own jsonb with no joins.
-- Trim persisted view sort lists to the cap.
--
-- View layouts are capped at VIEW_SORTS_MAX (8) sorts
-- (packages/api-contract/src/limits.ts). Before the cap the schema accepted
-- any array length and the UI could add one sort per property, so rows
-- written earlier may hold more. Keep the leading sorts: that is the order
-- the user chose, and the read path (`parseStoredViewLayout` in
-- src/lib/views-schema.ts) applies the same rule to any row written between
-- the API deploy and this migration, so the two converge on one shape.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
UPDATE "workspace_views"
  SET layout = jsonb_set(
    layout,
    '{sorts}',
    (
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(layout->'sorts') WITH ORDINALITY AS s(elem, ord)
      WHERE ord <= 8
    )
  )
  WHERE jsonb_typeof(layout->'sorts') = 'array'
    AND jsonb_array_length(layout->'sorts') > 8;--> statement-breakpoint
UPDATE "workspace_view_templates"
  SET layout = jsonb_set(
    layout,
    '{sorts}',
    (
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(layout->'sorts') WITH ORDINALITY AS s(elem, ord)
      WHERE ord <= 8
    )
  )
  WHERE jsonb_typeof(layout->'sorts') = 'array'
    AND jsonb_array_length(layout->'sorts') > 8;--> statement-breakpoint
-- Report exports snapshot the view layout they were built from and re-parse
-- it when the export runs.
UPDATE "report_exports"
  SET layout = jsonb_set(
    layout,
    '{sorts}',
    (
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(layout->'sorts') WITH ORDINALITY AS s(elem, ord)
      WHERE ord <= 8
    )
  )
  WHERE jsonb_typeof(layout->'sorts') = 'array'
    AND jsonb_array_length(layout->'sorts') > 8;
