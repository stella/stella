-- stella-migration-safety: reviewed destructive-change - Replaces only the rule-source value CHECK to admit 'retired'; every existing row satisfies the widened set, and rollback can restore the prior CHECK once no row carries the new value.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_polarity_rules"
  DROP CONSTRAINT "polarity_rules_source_values";--> statement-breakpoint

ALTER TABLE "case_law_polarity_rules"
  ADD CONSTRAINT "polarity_rules_source_values"
  CHECK ("source" IN ('manual', 'llm-proposed', 'llm-promoted', 'retired')) NOT VALID;--> statement-breakpoint

-- Validate outside Drizzle's migration transaction so PostgreSQL does not
-- hold the ADD CONSTRAINT lock for the duration of the table scan.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
ALTER TABLE "case_law_polarity_rules"
  VALIDATE CONSTRAINT "polarity_rules_source_values";--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
