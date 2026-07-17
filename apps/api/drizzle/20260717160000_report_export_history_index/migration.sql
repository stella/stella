-- Drizzle records this migration inside its bookkeeping transaction. The
-- migration entrypoint builds and verifies the index online immediately after
-- that transaction commits; see src/db/online-migrations.ts.
SELECT 1;
--> statement-breakpoint
