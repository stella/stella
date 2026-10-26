SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Normalized per-statement timing (parameters replaced by placeholders), so a
-- slow read can be named without logging its values. The library is preloaded
-- by the database parameter group; this only creates the views.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
