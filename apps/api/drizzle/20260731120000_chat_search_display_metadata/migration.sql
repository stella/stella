-- stella-migration-safety: reviewed bulk-backfill - marks only derived chat search projections; the bounded scheduler repair is resumable and old/new writers remain schema-compatible
-- Mark every existing chat projection for the bounded scheduler repair.
-- During a rolling deploy, old application tasks continue writing their real
-- preview generation UUID; the new writer clears it after rebuilding. Search
-- reads exclude marked rows, so internal reference-only matches cannot surface
-- through while the repair converges.
UPDATE chat_thread_search_documents
SET preview_generation = '00000000-0000-0000-0000-000000000001'::uuid
WHERE preview_generation IS NULL;
