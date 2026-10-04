-- requires: 20261003123500_reconciliation_listing_revision
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Commit the prerequisite and its migration receipt before validation.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5min';--> statement-breakpoint
ALTER TABLE "case_law_reconciliation_items"
  VALIDATE CONSTRAINT "case_law_reconciliation_items_revival_count_bounded";
