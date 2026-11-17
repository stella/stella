-- requires: 20260925220000_legal_list_verifications
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The list-and-document index of finished verification runs
-- (legal_list_verification_runs_list_document_idx) is built concurrently
-- after deploy by its online migration entry in
-- apps/api/src/db/online-migration-entries/.
