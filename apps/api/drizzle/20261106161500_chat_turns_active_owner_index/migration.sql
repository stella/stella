-- requires: 20260803100000_chat_turns
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The active-runs index (chat_turns_org_user_active_idx) is built
-- concurrently after deploy by its online migration entry in
-- apps/api/src/db/online-migration-entries/.
