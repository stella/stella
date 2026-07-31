SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A decision cites two different things: authority it invokes, and the
-- judgment it is reviewing (plus the first-instance file number) named in
-- its recitals. Only the first belongs in the citation graph — counting
-- the second would inflate the authority of whatever happened to be
-- appealed.
--
-- Defaults to 'precedent' so existing rows keep their present meaning
-- until the backfill classifies them; the ingest path sets it explicitly.
ALTER TABLE "case_law_citations"
  ADD COLUMN IF NOT EXISTS "kind" varchar(16) DEFAULT 'precedent' NOT NULL;--> statement-breakpoint

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "case_law_citations"
  ADD CONSTRAINT "citations_kind_values"
  CHECK ("kind" IN ('precedent','procedural')) NOT VALID;--> statement-breakpoint

-- Validated separately: NOT VALID avoids the full-table scan taking an
-- ACCESS EXCLUSIVE lock, and VALIDATE takes only a SHARE UPDATE EXCLUSIVE.
ALTER TABLE "case_law_citations" VALIDATE CONSTRAINT "citations_kind_values";--> statement-breakpoint

-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - drops only this
-- migration's own index by name before recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_precedent_cited_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_citations_precedent_cited_idx"
  ON "case_law_citations" ("cited_decision_id")
  WHERE "kind" = 'precedent' AND "cited_decision_id" IS NOT NULL;--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
