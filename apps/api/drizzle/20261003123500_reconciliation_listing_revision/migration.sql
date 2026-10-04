-- requires: 20260811110000_case_law_reconciliation_items
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Nullable and filled on bounded reconciliation visits; existing rows need no rewrite.
ALTER TABLE "case_law_reconciliation_items" ADD COLUMN "payload_hash" varchar(64),
  ADD COLUMN "revival_count" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "case_law_reconciliation_items_revival_count_bounded" CHECK ("revival_count" >= 0 AND "revival_count" <= 2) NOT VALID;
