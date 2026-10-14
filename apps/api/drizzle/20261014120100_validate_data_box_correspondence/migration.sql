-- requires: 20261014120000_data_box_correspondence
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Validate without retaining the constraint DDL locks through the scans.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so scans do not retain DDL locks.
ALTER TABLE "correspondence" VALIDATE CONSTRAINT "correspondence_channel_check";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so scans do not retain DDL locks.
ALTER TABLE "correspondence" VALIDATE CONSTRAINT "correspondence_data_box_check";
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
