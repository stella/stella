SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A split sitemap month is now cut into ranges of the decisions' date index,
-- named by a four-digit position, instead of into 64 hashed buckets. The
-- table holds one row per listed file (a few thousand), and the hashed rows
-- are dropped here: the enrollment this migration introduces recounts every
-- country, which lists those months again as ranges.
-- stella-migration-safety: reviewed delete-data - removes only hashed sitemap buckets, a derived listing the enrolled recount rebuilds; no decision is touched
DELETE FROM "case_law_sitemap_shards" WHERE "bucket" <> 'all';--> statement-breakpoint
-- The listing holds a few thousand rows, so even a rewrite would fit the
-- migration's 5s statement budget.
-- stella-migration-safety: bounded-type-rewrite
-- stella-migration-safety: reviewed alter-column-type - widening varchar(3) to varchar(4) is binary coercible, so the table is neither rewritten nor reindexed
ALTER TABLE "case_law_sitemap_shards" ALTER COLUMN "bucket" SET DATA TYPE varchar(4);--> statement-breakpoint
ALTER TABLE "case_law_sitemap_shards"
  ADD COLUMN "range_start_date" date,
  ADD COLUMN "range_start_id" uuid,
  ADD COLUMN "range_end_date" date,
  ADD COLUMN "range_end_id" uuid;--> statement-breakpoint
ALTER TABLE "case_law_sitemap_shards"
  ADD CONSTRAINT "case_law_sitemap_shards_range_bounds" CHECK (
    ("range_start_date" IS NULL) = ("range_start_id" IS NULL)
    AND ("range_end_date" IS NULL) = ("range_end_id" IS NULL)
    AND ("bucket" = 'all') = ("range_start_date" IS NULL AND "range_end_date" IS NULL)
  ) NOT VALID;--> statement-breakpoint
-- The shard read looks its range up before reading it, and refuses a file
-- whose count outgrew what one read may serve.
GRANT SELECT ("total", "range_start_date", "range_start_id", "range_end_date", "range_end_id")
  ON TABLE "case_law_sitemap_shards"
  TO "stella_public_law_reader";
