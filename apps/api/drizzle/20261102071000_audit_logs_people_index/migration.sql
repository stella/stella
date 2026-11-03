SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The people-only activity log index (audit_logs_org_people_created_id_idx)
-- is built concurrently after deploy by its online migration entry in
-- apps/api/src/db/online-migration-entries/.
