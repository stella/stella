SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The covering path for the sitemap's Work grouping, limited to versions the
-- publisher still lists so the grouping stays index-only with that filter.
-- The earlier refresh index stays until a later release drops it.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_sitemap_refresh_v2_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_sitemap_refresh_v2_idx"
  ON "legislation_documents" ("country", "source_id", "eli", "language", (coalesce("version_valid_from", DATE '0001-01-01')) DESC, "id" DESC, "version_valid_from", "slug", "updated_at")
  WHERE "slug" IS NOT NULL AND "window_disposition" <> 'withdrawn';
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
