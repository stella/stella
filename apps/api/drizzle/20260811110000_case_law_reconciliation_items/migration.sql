SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Where a listed decision sits once it has repeatedly refused to be ingested.
-- The reconciliation loop hunts the difference between what a publisher lists
-- for a slice and what is held; an item the publisher lists but never serves
-- would otherwise be re-fetched on every visit and the slice would never
-- settle. A row here is that item's memory: how often it has been tried, when
-- it may be tried again, and, once the schedule is exhausted, that it is
-- terminal and counts as accounted for rather than missing.
CREATE TABLE IF NOT EXISTS "case_law_reconciliation_items" (
  "id" uuid PRIMARY KEY NOT NULL,
  "source_id" uuid NOT NULL,
  "slice" varchar(64) NOT NULL,
  "identity_key" varchar(320) NOT NULL,
  "payload" jsonb NOT NULL,
  "status" varchar(16) DEFAULT 'parked' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz,
  "last_error" text,
  "first_seen_at" timestamptz DEFAULT now() NOT NULL,
  "last_attempt_at" timestamptz
);--> statement-breakpoint

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "case_law_reconciliation_items"
  ADD CONSTRAINT "case_law_reconciliation_items_source_id_case_law_sources_id_fk"
  FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- One row per identity per source: a second listing of the same decision
-- updates the attempt it already has instead of starting a parallel one.
CREATE UNIQUE INDEX IF NOT EXISTS "case_law_reconciliation_items_source_identity_idx"
  ON "case_law_reconciliation_items" ("source_id","identity_key");--> statement-breakpoint

-- The due-retry read is the loop's highest-priority work unit and asks only
-- about parked rows; terminal ones are dead weight in it.
CREATE INDEX IF NOT EXISTS "case_law_reconciliation_items_due_idx"
  ON "case_law_reconciliation_items" ("source_id","next_attempt_at")
  WHERE "status" = 'parked';--> statement-breakpoint

-- Settledness per slice: a slice is done when what is held plus what is
-- terminal accounts for everything the publisher listed.
CREATE INDEX IF NOT EXISTS "case_law_reconciliation_items_slice_idx"
  ON "case_law_reconciliation_items" ("source_id","slice","status");--> statement-breakpoint

-- Added validating, not NOT VALID + VALIDATE: the table is created empty in
-- this same migration, so the scan is over no rows. The migrator wraps a
-- migration in one transaction in any case, so a split would not release the
-- locks it is meant to release.
ALTER TABLE "case_law_reconciliation_items"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_reconciliation_items_status_values"
  CHECK ("status" IN ('parked', 'terminal'));--> statement-breakpoint

ALTER TABLE "case_law_reconciliation_items"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_reconciliation_items_attempts_nonnegative"
  CHECK ("attempts" >= 0);--> statement-breakpoint

-- A parked row with no due time would never be selected again, which is the
-- silent version of terminal without the accounting terminal brings.
ALTER TABLE "case_law_reconciliation_items"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_reconciliation_items_parked_is_scheduled"
  CHECK ("status" <> 'parked' OR "next_attempt_at" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "case_law_reconciliation_items"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Same access shape as the coverage ledger this sits beside: the app role
-- reads it for the ingestion status rollup, only ingestion writes it.
CREATE POLICY "case_law_global_access" ON "case_law_reconciliation_items" AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_reconciliation_items" AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

-- RLS restricts rows, grants restrict verbs — both are needed.
GRANT SELECT ON TABLE "case_law_reconciliation_items" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_reconciliation_items" TO stella_ingestion;
