SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The unserved gauge's indexes (corpus_index_projection_intents_delete_unproven_idx
-- and corpus_index_projection_states_absent_idx) are built concurrently after
-- deploy by their online migration entries in
-- apps/api/src/db/online-migration-entries/.
