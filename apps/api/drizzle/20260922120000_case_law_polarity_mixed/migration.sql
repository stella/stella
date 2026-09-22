SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Admit 'mixed' into the polarity value CHECKs. A citing decision may name
-- the same case several times, and the mentions need not agree; the reading
-- that records a departure at one mention and reliance at another had no
-- spelling, so it was stored as whichever mention outranked the other.
--
-- Both constraints are widened together because both derive from
-- `POLARITIES` in the schema, and `schema-invariants.test.ts` compares each
-- one's text against that list.
--
-- stella-migration-safety: reviewed drop-constraint - replaces the citation
-- polarity value CHECK with a strictly wider set, so every existing row
-- satisfies it; rollback restores the prior CHECK once no row carries the
-- new value.
ALTER TABLE "case_law_citations"
  DROP CONSTRAINT IF EXISTS "citations_polarity_values";--> statement-breakpoint

ALTER TABLE "case_law_citations"
  ADD CONSTRAINT "citations_polarity_values"
  CHECK ("polarity" IN ('positive', 'supportive', 'neutral', 'negative', 'mixed', 'unknown')) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - the same widening on
-- the rule table, whose CHECK derives from the same list; no rule carries
-- 'mixed', which the rule loader enforces, but the two constraints are read
-- as one declaration.
ALTER TABLE "case_law_polarity_rules"
  DROP CONSTRAINT IF EXISTS "polarity_rules_polarity_values";--> statement-breakpoint

ALTER TABLE "case_law_polarity_rules"
  ADD CONSTRAINT "polarity_rules_polarity_values"
  CHECK ("polarity" IN ('positive', 'supportive', 'neutral', 'negative', 'mixed', 'unknown')) NOT VALID;--> statement-breakpoint

-- Validate outside Drizzle's migration transaction so PostgreSQL does not
-- hold the ADD CONSTRAINT lock for the duration of the table scan. The
-- citation table is the large one; a widened CHECK cannot reject a row the
-- narrower one accepted, so the scan only clears the NOT VALID marker.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint

ALTER TABLE "case_law_citations"
  VALIDATE CONSTRAINT "citations_polarity_values";--> statement-breakpoint
ALTER TABLE "case_law_polarity_rules"
  VALIDATE CONSTRAINT "polarity_rules_polarity_values";--> statement-breakpoint

SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
