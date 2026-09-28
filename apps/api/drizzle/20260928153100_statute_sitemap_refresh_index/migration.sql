SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A covering access path for the scheduled Work grouping. The predicate
-- matches the slug requirement in the refresh and the shard read.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_sitemap_refresh_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_sitemap_refresh_idx"
  ON "legislation_documents" ("country", "source_id", "eli", "language", (coalesce("version_valid_from", DATE '0001-01-01')) DESC, "id" DESC, "version_valid_from", "slug", "updated_at")
  WHERE "slug" IS NOT NULL;
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
