SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '30min';
--> statement-breakpoint
-- Finish the migrator transaction before validating so the scan does not
-- retain the preceding migration's locks. The index build must also run
-- outside a transaction; Drizzle gets a fresh transaction at the end to
-- record success.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- validating an already-valid constraint is a no-op, so a retry of this migration is idempotent
ALTER TABLE "chat_threads" VALIDATE CONSTRAINT "chat_threads_parent_thread_id_chat_threads_id_fkey";
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- Serves the parent reference's ON DELETE SET NULL scan: without it every
-- thread delete reads all of chat_threads. Partial because only a fork
-- carries a parent. The retry drop targets only this migration's index; an
-- interrupted concurrent build leaves an INVALID index that would otherwise
-- block recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "chat_threads_parent_thread_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- the retry drop above removes an INVALID build before recreation
CREATE INDEX CONCURRENTLY "chat_threads_parent_thread_idx"
  ON "chat_threads" ("parent_thread_id")
  WHERE "parent_thread_id" IS NOT NULL;
--> statement-breakpoint
SET statement_timeout = '30min';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
