-- Candidate index for the file-derivative repair sweep. Its steady state is an
-- empty candidate set, so without a partial index matching the sweep's
-- predicate every tick would scan `fields` end to end to find nothing. The
-- cursor column leads, because the sweep pages by a global id cursor.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, build the large-table index without
-- write-blocking locks, then reopen a transaction for Drizzle's migration row.
SET lock_timeout = '1s';
--> statement-breakpoint
SELECT set_config(
  'stella.migration_statement_timeout',
  current_setting('statement_timeout'),
  false
);
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- IF NOT EXISTS would retain an INVALID index left by an interrupted concurrent build
CREATE INDEX CONCURRENTLY "fields_derivative_repair_candidate_idx"
  ON "fields" ("id")
  WHERE "content"->>'type' = 'file'
    AND (
      coalesce("content"->'pdfDerivative'->>'status', 'pending')
        NOT IN ('ready', 'not-required')
      OR coalesce("content"->'thumbnailDerivative'->>'status', 'pending')
        NOT IN ('ready', 'not-required')
    );
--> statement-breakpoint
SELECT set_config(
  'statement_timeout',
  current_setting('stella.migration_statement_timeout'),
  false
);
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
