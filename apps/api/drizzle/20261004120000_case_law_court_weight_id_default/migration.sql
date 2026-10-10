SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The court weight seed migrations draw "id" from gen_random_uuid(), so a
-- database migrated at deploy time and one migrated later hold different ids
-- for the same rows. Declaring the volatile default states that the column is
-- a surrogate key: the migration catalog comparison excludes it like every
-- other volatile-default column, and later seeds can omit it.
ALTER TABLE "case_law_court_weights" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
