-- requires: 20261010003000_search_history_import_cutoffs
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- The jurisdiction each entry belongs to, so the law home lists one country's
-- history. Existing rows stay null until reused; the owner/country index is
-- built online (ONLINE_MIGRATION_INDEXES).
ALTER TABLE "search_history_entries" ADD COLUMN "country" text;--> statement-breakpoint

-- When the latest use naming the jurisdiction happened, so a later use files
-- the entry whatever order uses arrive in.
ALTER TABLE "search_history_entries" ADD COLUMN "country_used_at" timestamp with time zone;
