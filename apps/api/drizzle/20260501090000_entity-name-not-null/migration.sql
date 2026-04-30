-- entities.name becomes NOT NULL across the board.
--
-- Every entity kind (folder, document, task, link, message) has a
-- canonical display label that the UI relies on. Folders only
-- worked by accident because their name was always set; documents
-- and historical rows could end up null between insert and the
-- post-create update step. Backfill any orphaned rows with a
-- safe placeholder so the ALTER cannot fail mid-migration, then
-- enforce the invariant going forward.

UPDATE "entities" SET "name" = 'Untitled' WHERE "name" IS NULL;
--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "name" SET NOT NULL;
