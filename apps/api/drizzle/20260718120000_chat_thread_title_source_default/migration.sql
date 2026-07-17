SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - widening varchar(4) -> varchar(7) is a metadata-only catalog change (no table rewrite, no data loss); it only enlarges the length limit so the new "default" title-source value fits. Rollback is to shrink back to varchar(4) once no row exceeds it.
ALTER TABLE "chat_threads" ALTER COLUMN "title_source" SET DATA TYPE varchar(7);--> statement-breakpoint
-- New threads now start "default" (AI-replaceable placeholder) instead of
-- "user". Existing rows are intentionally left as-is: AI titling only fires for
-- threads created in the same send-message request, so it never runs against
-- pre-existing rows. Backfilling "user" -> "default" would risk re-opening
-- genuine renames to AI overwrite, so those rows keep "user" and stay protected.
ALTER TABLE "chat_threads" ALTER COLUMN "title_source" SET DEFAULT 'default';
