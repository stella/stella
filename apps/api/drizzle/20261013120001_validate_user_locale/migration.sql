SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Release the preceding migration's DDL locks before scanning existing users.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation is replayable and runs after the additive DDL transaction commits.
ALTER TABLE "user" VALIDATE CONSTRAINT "user_locale_supported_check";
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
