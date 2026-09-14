SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint

-- Access path for the statute sitemap shards. A shard filters on the bucket
-- its ELI hashes into; the (country, slug) index cannot seek that expression,
-- so without this one every shard request scans the jurisdiction's whole slug
-- range and a crawler repeats that scan once per advertised shard. Measured
-- on 50k works x 3 consolidations: sequential scan 37ms discarding 147,666
-- rows, index scan 6ms reading 2,334. The expression is `statuteSitemapBucket`
-- in src/db/schema/legislation.ts, which the sitemap predicate renders too, so
-- the filter and the index cannot drift.

-- Built CONCURRENTLY so the corpus table never write-locks for the build.
-- Drizzle wraps pending migrations in one transaction and CREATE INDEX
-- CONCURRENTLY must run outside one: COMMIT, build, then BEGIN again for the
-- migrator's bookkeeping row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- The retry drop targets only the index this migration introduces; an
-- interrupted concurrent build leaves it INVALID, and a rerun must replace it
-- rather than skip it.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_sitemap_bucket_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- the retry drop above removes an INVALID build before recreation
CREATE INDEX CONCURRENTLY "legislation_documents_sitemap_bucket_idx"
ON "legislation_documents" (
  "country",
  (lpad(mod(hashtext("eli")::bigint + 2147483648, 64)::text, 2, '0')),
  "eli"
)
WHERE "slug" IS NOT NULL;
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
