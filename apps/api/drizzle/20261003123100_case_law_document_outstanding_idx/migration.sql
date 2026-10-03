SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Drizzle records this migration inside its bookkeeping transaction.
-- The migration entrypoint builds the outstanding-document index CONCURRENTLY
-- and verifies it in the online phase after that transaction commits.
SELECT 1;
--> statement-breakpoint
