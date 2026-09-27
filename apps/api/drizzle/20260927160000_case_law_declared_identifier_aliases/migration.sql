SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- When an identifier was declared an alias of the decision rather than derived
-- from its observation: the spelling of a record retired into this decision.
-- A refresh re-derives the observed identifiers and keeps declared ones.
-- Nullable with no default, so adding it rewrites no row.
ALTER TABLE "case_law_decision_identifiers" ADD COLUMN IF NOT EXISTS "declared_at" timestamp with time zone;--> statement-breakpoint

-- The public reader holds column grants on this table; a relational read of
-- a decision's identifiers selects every column.
GRANT SELECT ("declared_at") ON TABLE "case_law_decision_identifiers"
  TO stella_public_law_reader;
