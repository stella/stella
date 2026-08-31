SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '120s';--> statement-breakpoint

-- Positions v2 -> v3: a graded position's `tiers` becomes
-- `standard: { source: "tiers", tiers }`, so a position derived from a
-- reference document can occupy the same field. The pre-lift value is kept in
-- a `_v2` column so a rollback to the previous image restores it; a follow-up
-- release drops the backups.
ALTER TABLE "playbook_definitions"
  ADD COLUMN IF NOT EXISTS "positions_v2" jsonb;--> statement-breakpoint

ALTER TABLE "playbook_definition_versions"
  ADD COLUMN IF NOT EXISTS "positions_v2" jsonb;--> statement-breakpoint

-- Guarded on `version = 2`, so a replay lifts nothing a second time.
UPDATE "playbook_definitions"
   SET "positions_v2" = "positions",
       "positions" = jsonb_build_object(
         'version', 3,
         'items', COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN item ? 'tiers'
                      THEN (item - 'tiers') || jsonb_build_object(
                             'standard',
                             jsonb_build_object('source', 'tiers', 'tiers', item->'tiers')
                           )
                      ELSE item
                    END
                    ORDER BY ord
                  )
             FROM jsonb_array_elements("positions"->'items')
                  WITH ORDINALITY AS entry(item, ord)
         ), '[]'::jsonb)
       )
 WHERE "positions"->>'version' = '2';--> statement-breakpoint

UPDATE "playbook_definition_versions"
   SET "positions_v2" = "positions",
       "positions" = jsonb_build_object(
         'version', 3,
         'items', COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN item ? 'tiers'
                      THEN (item - 'tiers') || jsonb_build_object(
                             'standard',
                             jsonb_build_object('source', 'tiers', 'tiers', item->'tiers')
                           )
                      ELSE item
                    END
                    ORDER BY ord
                  )
             FROM jsonb_array_elements("positions"->'items')
                  WITH ORDINALITY AS entry(item, ord)
         ), '[]'::jsonb)
       )
 WHERE "positions"->>'version' = '2';--> statement-breakpoint

-- A run pins its playbook by value, so the same lift applies inside the
-- snapshot. The whole basis is backed up here rather than the positions alone:
-- the next migration rewrites the rest of it, and one backup column is what a
-- rollback restores.
ALTER TABLE "document_review_runs"
  ADD COLUMN IF NOT EXISTS "basis_v1" jsonb;--> statement-breakpoint

UPDATE "document_review_runs"
   SET "basis_v1" = "basis",
       "basis" = jsonb_set(
         "basis",
         '{playbook,definitionSnapshot,positions}',
         jsonb_build_object(
           'version', 3,
           'items', COALESCE((
             SELECT jsonb_agg(
                      CASE WHEN item ? 'tiers'
                        THEN (item - 'tiers') || jsonb_build_object(
                               'standard',
                               jsonb_build_object('source', 'tiers', 'tiers', item->'tiers')
                             )
                        ELSE item
                      END
                      ORDER BY ord
                    )
               FROM jsonb_array_elements(
                      "basis"->'playbook'->'definitionSnapshot'->'positions'->'items'
                    ) WITH ORDINALITY AS entry(item, ord)
           ), '[]'::jsonb)
         )
       )
 WHERE "basis"->'playbook'->'definitionSnapshot'->'positions'->>'version' = '2';
