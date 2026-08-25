SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '120s';--> statement-breakpoint

-- The basis stops being a three-way union. Every run now pins one position
-- list, the reference documents those positions came from, and the side it was
-- judged for. A run that was measured against reference documents alone had no
-- position list at all: its confirmed topics become positions whose standard
-- is a reference, under an ephemeral pin (no definition was ever saved). A
-- combined run keeps its playbook and gains the same derived positions, so
-- every finding it holds still names a position its snapshot carries.
--
-- Passages are empty on a derived position: the pre-lift topic recorded a
-- title and a note, never the reference text. Those runs are completed and
-- read-only; nothing re-grades them.
UPDATE "document_review_runs"
   SET "basis" = CASE "basis"->>'type'
         WHEN 'playbook' THEN jsonb_build_object(
           'playbook', "basis"->'playbook',
           'references', '[]'::jsonb,
           'perspective', '{"type":"neutral"}'::jsonb
         )
         WHEN 'combined' THEN jsonb_build_object(
           'playbook', jsonb_set(
             "basis"->'playbook',
             '{definitionSnapshot,positions,items}',
             COALESCE("basis"->'playbook'->'definitionSnapshot'->'positions'->'items', '[]'::jsonb)
               || COALESCE((
                    SELECT jsonb_agg(
                             jsonb_build_object(
                               'mode', 'graded',
                               'sourceId', topic->>'topicId',
                               'issue', topic->>'title',
                               'severity', 'medium',
                               'standard', jsonb_build_object(
                                 'source', 'reference',
                                 'passages', '[]'::jsonb
                               ),
                               'ask', '{"mode":"auto"}'::jsonb,
                               'enabled', true
                             ) ORDER BY ord
                           )
                      FROM jsonb_array_elements("topics") WITH ORDINALITY AS entry(topic, ord)
                     WHERE topic->>'type' <> 'playbook'
                       AND COALESCE((topic->>'included')::boolean, false)
                  ), '[]'::jsonb)
           ),
           'references', COALESCE("basis"->'references', '[]'::jsonb),
           'perspective', COALESCE("basis"->'perspective', '{"type":"neutral"}'::jsonb)
         )
         ELSE jsonb_build_object(
           'playbook', jsonb_build_object(
             'definitionId', 'null'::jsonb,
             'versionId', 'null'::jsonb,
             'provenance', 'ephemeral',
             'definitionSnapshot', jsonb_build_object(
               'name', 'Positions confirmed for this review',
               'positions', jsonb_build_object(
                 'version', 3,
                 'items', COALESCE((
                   SELECT jsonb_agg(
                            jsonb_build_object(
                              'mode', 'graded',
                              'sourceId', topic->>'topicId',
                              'issue', topic->>'title',
                              'severity', 'medium',
                              'standard', jsonb_build_object(
                                'source', 'reference',
                                'passages', '[]'::jsonb
                              ),
                              'ask', '{"mode":"auto"}'::jsonb,
                              'enabled', true
                            ) ORDER BY ord
                          )
                     FROM jsonb_array_elements("topics") WITH ORDINALITY AS entry(topic, ord)
                    WHERE topic->>'type' <> 'playbook'
                      AND COALESCE((topic->>'included')::boolean, false)
                 ), '[]'::jsonb)
               )
             )
           ),
           'references', COALESCE("basis"->'references', '[]'::jsonb),
           'perspective', COALESCE("basis"->'perspective', '{"type":"neutral"}'::jsonb)
         )
       END
 WHERE "basis" ? 'type';--> statement-breakpoint

-- The rolling-deploy bridge normalized the pre-cross-matter basis on insert.
-- No supported release publishes that shape any more, and it writes the union
-- this migration just removed, so it goes out with the union.
-- stella-migration-safety: reviewed drop-object - removes the v1 basis normalization trigger and its function; the union it normalized no longer exists and the worker that produced it ships out in this release.
DROP TRIGGER IF EXISTS "document_review_runs_normalize_v1_basis_trigger"
  ON "document_review_runs";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the trigger above was its only caller.
DROP FUNCTION IF EXISTS "document_review_runs_normalize_v1_basis"();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - the basis discriminator it checked is gone; the shape check below replaces it.
ALTER TABLE "document_review_runs"
  DROP CONSTRAINT IF EXISTS "document_review_runs_basis_type_check";--> statement-breakpoint

ALTER TABLE "document_review_runs"
  ADD CONSTRAINT "document_review_runs_basis_shape_check"
  CHECK (
    "basis"->'playbook'->>'provenance' IN ('approved', 'draft', 'ephemeral')
    AND jsonb_typeof("basis"->'playbook'->'definitionSnapshot'->'positions') = 'object'
  ) NOT VALID;--> statement-breakpoint

-- The confirmed list lives in the pinned snapshot now, so the column that held
-- it separately would be a second copy nothing reads. `basis_v1` (previous
-- migration) still holds the pre-lift basis for a rollback; `topics` is
-- recoverable from it only for rows that had one, which is exactly the set a
-- rollback needs.
-- stella-migration-safety: reviewed drop-column - the confirmed list is now inside basis.playbook.definitionSnapshot.positions, lifted above; the pre-lift value stays in document_review_runs.basis_v1 until a follow-up release drops the backup.
ALTER TABLE "document_review_runs"
  DROP COLUMN IF EXISTS "topics";--> statement-breakpoint

-- The engine that produces a run changed shape, so a pre-lift run must never
-- read as if today's engine had produced it.
ALTER TABLE "document_review_runs"
  ALTER COLUMN "pipeline_version" SET DEFAULT 2;
