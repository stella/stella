SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Corpus generation activation takes a short table lock while it changes the
-- generation registry. MAINTAIN permits that lock without broadening the
-- ingestion role's column-scoped source writes.
GRANT MAINTAIN ON TABLE "legislation_sources" TO stella_ingestion;--> statement-breakpoint
