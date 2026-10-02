-- requires: 20260811110000_case_law_reconciliation_items
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Nullable and filled on bounded reconciliation visits; existing rows need no rewrite.
ALTER TABLE "case_law_reconciliation_items" ADD COLUMN "payload_hash" varchar(64);
