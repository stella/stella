SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- When an identifier was declared an alias of the decision rather than derived
-- from its observation: the spelling of a record retired into this decision.
-- A refresh re-derives the observed identifiers and keeps declared ones. The
-- public reader is not granted it: no public read needs it.
-- Nullable with no default, so adding it rewrites no row.
ALTER TABLE "case_law_decision_identifiers" ADD COLUMN IF NOT EXISTS "declared_at" timestamp with time zone;
