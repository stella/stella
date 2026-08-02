SELECT set_config(
  'stella.migration_lock_timeout',
  current_setting('lock_timeout'),
  false
);
--> statement-breakpoint
SELECT set_config(
  'stella.migration_statement_timeout',
  current_setting('statement_timeout'),
  false
);
--> statement-breakpoint
SET lock_timeout = '2s';
--> statement-breakpoint
SET statement_timeout = '0';
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- The runner validates this index and concurrently repairs an INVALID build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_createdAt_idx" ON "user" USING btree ("created_at","id");
--> statement-breakpoint
SELECT set_config(
  'statement_timeout',
  current_setting('stella.migration_statement_timeout'),
  false
);
--> statement-breakpoint
SELECT set_config(
  'lock_timeout',
  current_setting('stella.migration_lock_timeout'),
  false
);
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
