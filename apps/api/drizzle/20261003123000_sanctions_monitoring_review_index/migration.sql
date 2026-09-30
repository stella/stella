-- requires: 20261003122900_sanctions_monitoring_reviews
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS sanctions_contact_matches_org_open_cursor_idx ON sanctions_contact_matches (organization_id, state, disposition, contact_id, source_id, source_entry_id);--> statement-breakpoint
REINDEX INDEX CONCURRENTLY sanctions_contact_matches_org_open_cursor_idx;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS sanctions_screening_events_org_cursor_idx ON sanctions_screening_events (organization_id, created_at, id);--> statement-breakpoint
REINDEX INDEX CONCURRENTLY sanctions_screening_events_org_cursor_idx;--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
