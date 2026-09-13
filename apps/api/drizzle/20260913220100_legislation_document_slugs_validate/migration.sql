SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- One row per consolidation of every act the corpus holds, so the scan tracks
-- corpus volume rather than workspace volume; the 5s budget the additive
-- migration runs under does not cover it. Its own migration: the scan runs in
-- its own transaction under SHARE UPDATE EXCLUSIVE, and a timeout here fails
-- this table alone and is retried by rerunning it.

ALTER TABLE "legislation_documents"
  VALIDATE CONSTRAINT "legislation_documents_slug_shape";
