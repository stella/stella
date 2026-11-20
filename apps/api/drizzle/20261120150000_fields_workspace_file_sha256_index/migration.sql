-- requires: 20260813210000_file_derivative_repair_index
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The per-matter file hash index (fields_workspace_file_sha256_idx) that the
-- exact-duplicate upload check reads is built concurrently after deploy by
-- its online migration entry in apps/api/src/db/online-migration-entries/.
