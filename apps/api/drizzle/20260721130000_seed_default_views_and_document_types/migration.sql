-- Backfill the rows that the `views.list` and `document-types.list` handlers
-- used to seed lazily on first read. Those handlers are now pure reads (a
-- read-only credential must not be able to create data by listing), so:
--   * new workspaces get their default views at creation
--     (handlers/workspaces/create.ts)
--   * new organizations get their default document types at creation
--     (afterCreateOrganization in lib/auth.ts)
-- This migration seeds the *pre-existing* workspaces/orgs that were created
-- before the change and never had their defaults materialized. Both statements
-- are additive and idempotent: a `NOT EXISTS` guard skips any workspace/org
-- that already has rows, so re-running is a no-op.

-- Default views: one full set per workspace that currently has none. The table
-- view pins the workspace's system file property as its first column, matching
-- getDefaultViews(lang, { tableColumnPinning: [filePropertyId] }). Names are
-- stored in the source language ("en") and re-localized on read (see
-- localizeDefaultViewName), so the persisted language is invisible to users.
-- Keep the layout shapes in parity with emptyLayout() in lib/views.ts.
INSERT INTO "workspace_views" ("id", "workspace_id", "name", "layout", "position")
SELECT
  gen_random_uuid(),
  e."workspace_id",
  d."view_name",
  CASE d."layout_type"
    WHEN 'overview' THEN jsonb_build_object(
      'version', 1,
      'type', 'overview',
      'filters', '[]'::jsonb,
      'sorts', '[]'::jsonb,
      'hiddenProperties', '[]'::jsonb
    )
    WHEN 'filesystem' THEN jsonb_build_object(
      'version', 1,
      'type', 'filesystem',
      'filters', '[]'::jsonb,
      'sorts', '[]'::jsonb,
      'hiddenProperties', '[]'::jsonb
    )
    WHEN 'kanban' THEN jsonb_build_object(
      'version', 1,
      'type', 'kanban',
      'filters', '[]'::jsonb,
      'sorts', '[]'::jsonb,
      'hiddenProperties', '[]'::jsonb,
      'groupByPropertyId', '_status'
    )
    ELSE jsonb_build_object(
      'version', 1,
      'type', 'table',
      'filters', '[]'::jsonb,
      'sorts', '[]'::jsonb,
      'hiddenProperties', '[]'::jsonb,
      'columnOrder', '[]'::jsonb,
      'columnPinning', CASE
        WHEN e."file_property_id" IS NOT NULL
        THEN jsonb_build_array(e."file_property_id")
        ELSE '[]'::jsonb
      END
    )
  END,
  d."view_position"
FROM (
  SELECT
    w."id" AS "workspace_id",
    (
      SELECT p."id"
      FROM "properties" p
      WHERE p."workspace_id" = w."id"
        AND p."system" = true
        AND p."content" ->> 'type' = 'file'
      ORDER BY p."created_at" ASC
      LIMIT 1
    ) AS "file_property_id"
  FROM "workspaces" w
  WHERE NOT EXISTS (
    SELECT 1 FROM "workspace_views" v WHERE v."workspace_id" = w."id"
  )
) e
CROSS JOIN (
  VALUES
    ('overview', 'Overview', 0),
    ('table', 'Table', 1),
    ('filesystem', 'Files', 2),
    ('kanban', 'Todos', 3)
) AS d("layout_type", "view_name", "view_position");
--> statement-breakpoint

-- Default document types: the full starter taxonomy per organization that
-- currently has none. Keep in parity with DEFAULT_DOCUMENT_TYPES in
-- handlers/document-types/defaults.ts. `ON CONFLICT DO NOTHING` additionally
-- absorbs the narrow deploy-window race where an old API task (still running
-- the lazy-seed code) seeds the same org between this SELECT and its INSERT.
INSERT INTO "document_types" ("id", "organization_id", "key", "label", "sort_order")
SELECT gen_random_uuid(), o."id", d."key", d."label", d."sort_order"
FROM "organization" o
CROSS JOIN (
  VALUES
    ('nda', 'Non-Disclosure Agreement', 0),
    ('spa', 'Share Purchase Agreement', 1),
    ('apa', 'Asset Purchase Agreement', 2),
    ('shareholders', 'Shareholders'' Agreement', 3),
    ('msa', 'Master Services Agreement', 4),
    ('sla', 'Service Level Agreement', 5),
    ('dpa', 'Data Processing Agreement', 6),
    ('saas', 'SaaS Agreement', 7),
    ('employment', 'Employment Agreement', 8),
    ('consultancy', 'Consultancy Agreement', 9),
    ('lease', 'Lease Agreement', 10),
    ('loan', 'Loan / Facility Agreement', 11),
    ('guarantee', 'Guarantee', 12),
    ('poa', 'Power of Attorney', 13),
    ('license', 'Licence Agreement', 14),
    ('distribution', 'Distribution Agreement', 15),
    ('supply', 'Supply Agreement', 16),
    ('settlement', 'Settlement Agreement', 17),
    ('termsheet', 'Term Sheet / LOI', 18),
    ('other', 'Other', 19)
) AS d("key", "label", "sort_order")
WHERE NOT EXISTS (
  SELECT 1 FROM "document_types" dt WHERE dt."organization_id" = o."id"
)
ON CONFLICT DO NOTHING;
