SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- The document's own language, primarily as declared by the DOCX `w:lang` run
-- defaults, stored per version as a DOCUMENT_TRANSLATION_SOURCE_LANGUAGES code
-- (BCP-47 shaped: 'CS', 'EN-GB', 'PT-PT'). Null means not detected, or not a
-- DOCX at all -- so the translation dialog can propose the language the rest
-- of the matter is written in without re-reading every file in it.
--
-- Nullable with no default, so the add is metadata-only and reads no existing
-- row. Two producers write it, both `WHERE detected_language IS NULL` (first
-- writer wins, replay-safe): native extraction at ingestion, and the
-- translation-preparation endpoint for versions that predate this column.
-- There is no backfill; a null on an old version is expected, not a fault.
--
-- No index: the only reader aggregates the column inside one matter, reached
-- through "entities_workspace_id_idx" and a primary-key lookup per current
-- version, so this is a post-join filter over a bounded set rather than a
-- search key of its own.
ALTER TABLE "entity_versions"
  ADD COLUMN "detected_language" varchar(10);
