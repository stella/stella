SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Czech and Slovak decisions are identified by court: the write boundary reads
-- the court name a publisher prints onto the court directory and stores the
-- directory court's id beside it (`decision-court-identity.ts`). The court id
-- CHECK admitted an id on USA rows only, so it is replaced by one that admits
-- it on CZE and SVK rows as well. It does not yet require one there: rows
-- stored before this release hold none until the operator's repair
-- (src/scripts/repair-court-identity.ts) gives them theirs, and a CHECK that
-- required it would make every one of them unwritable. USA rows still require
-- an id and every other country still refuses one.
--
-- The CHECK is the rendering of `decisionCourtIdByCountrySql`
-- (apps/api/src/lib/case-law/decision-court-id-sql.ts), which
-- `decision-court-identity.db.test.ts` compares against this file. It is added
-- NOT VALID: every stored row satisfies it already, since the constraint it
-- replaces is stricter for every country. Drop and add are one ALTER, so they
-- take the table's lock once and no write lands between them.
-- stella-migration-safety: reviewed drop-constraint - The replacement CHECK is added by the same statement and admits every row the dropped one admitted; USA still requires a court id and every country other than CZE and SVK still refuses one.
ALTER TABLE "case_law_decisions"
  DROP CONSTRAINT IF EXISTS "case_law_decisions_court_id_by_country",
  ADD CONSTRAINT "case_law_decisions_court_id_by_country"
  CHECK ((CASE WHEN "country" IN ('USA') THEN "court_id" IS NOT NULL WHEN "country" IN ('CZE', 'SVK') THEN true ELSE "court_id" IS NULL END)) NOT VALID;
