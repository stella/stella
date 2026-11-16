SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A split sitemap month is now cut into ranges of the decisions' date index,
-- named by a four-digit position, instead of into 64 hashed buckets. The
-- listing keeps every row it holds: the enrollment this migration introduces
-- discovers each listed country from it and recounts its months into ranges,
-- and a refresh of the release before this one may still write hashed rows
-- while the rollout runs. The listing holds a few thousand rows, so even a
-- rewrite would fit the migration's 5s statement budget.
-- stella-migration-safety: bounded-type-rewrite
-- stella-migration-safety: reviewed alter-column-type - widening varchar(3) to varchar(4) is binary coercible, so the table is neither rewritten nor reindexed
ALTER TABLE "case_law_sitemap_shards" ALTER COLUMN "bucket" SET DATA TYPE varchar(4);--> statement-breakpoint
ALTER TABLE "case_law_sitemap_shards"
  ADD COLUMN "range_start_date" date,
  ADD COLUMN "range_start_id" uuid,
  ADD COLUMN "range_end_date" date,
  ADD COLUMN "range_end_id" uuid;--> statement-breakpoint
-- The shard read looks its range up before reading it, and refuses a file
-- whose count outgrew what one read may serve.
GRANT SELECT ("total", "range_start_date", "range_start_id", "range_end_date", "range_end_id")
  ON TABLE "case_law_sitemap_shards"
  TO "stella_public_law_reader";
