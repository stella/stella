SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The follow-up the cutover named (20260913210000_legal_reader_annotations).
-- That deploy is out: every task reads and writes "legal_reader_annotations",
-- and nothing resolves the retiring table any more.
--
-- The cutover ran no dual writes, so a task still serving the previous build
-- went on writing the old table after its rows were copied: a mark left there
-- exists nowhere else, and a mark edited there left a stale copy behind. This
-- collects both, keyed on the id the cutover carried over. An edit is taken
-- only when the old row is strictly the newer of the two, so a mark the reader
-- has since changed on the current build is never rolled back to the value the
-- retiring table holds.
--
-- A mark *deleted* on the previous build during that window is not reconciled:
-- its copy has outlived it since the cutover, and telling that copy from a mark
-- created on the current build takes an inference from the rollout clock that
-- deletes a reader's own words when it is wrong. A surviving highlight the
-- reader can remove again is the cheaper failure.

-- stella-migration-safety: reviewed insert-select - one read of the retiring
-- reader-notes table, which is not registered as high-volume and holds at most
-- the marks left during a single rollout; the ON CONFLICT arbiter is the
-- target's own primary key and the DO UPDATE is guarded by updated_at, so a
-- replay neither copies a row twice nor moves one backwards.
INSERT INTO "legal_reader_annotations" (
  "id", "organization_id", "user_id", "target_type", "target_id", "group_id",
  "kind", "visibility", "color", "style", "block_anchor_id", "start_offset",
  "end_offset", "quote", "body", "created_at", "updated_at"
)
SELECT
  "id", "organization_id", "user_id", 'decision', "decision_id", "group_id",
  "kind", "visibility", "color", "style", "block_anchor_id", "start_offset",
  "end_offset", "quote", "body", "created_at", "updated_at"
FROM "case_law_decision_annotations"
ON CONFLICT ON CONSTRAINT "legal_reader_annotations_pkey" DO UPDATE SET
  "group_id" = EXCLUDED."group_id",
  "kind" = EXCLUDED."kind",
  "visibility" = EXCLUDED."visibility",
  "color" = EXCLUDED."color",
  "style" = EXCLUDED."style",
  "block_anchor_id" = EXCLUDED."block_anchor_id",
  "start_offset" = EXCLUDED."start_offset",
  "end_offset" = EXCLUDED."end_offset",
  "quote" = EXCLUDED."quote",
  "body" = EXCLUDED."body",
  "updated_at" = EXCLUDED."updated_at"
WHERE EXCLUDED."updated_at" > "legal_reader_annotations"."updated_at";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - every row now lives in
-- "legal_reader_annotations", and no route, handler or prompt has named this
-- table since the cutover deploy. Its indexes, its row-level policies and its
-- single grant to "stella" are owned by the table and go with it, so no REVOKE
-- or DROP POLICY has to precede the drop, and nothing references it, so no
-- CASCADE either. Rollback is a redeploy of the current image, which reads
-- only the replacement.
DROP TABLE IF EXISTS "case_law_decision_annotations";
