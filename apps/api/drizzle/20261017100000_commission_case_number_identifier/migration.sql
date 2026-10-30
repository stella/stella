-- requires: 20260824230000_case_law_decision_identifiers
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The replacement checks add one accepted identifier type. Existing rows
-- satisfy them because the previous checks enforced a strict subset. They are
-- added NOT VALID and validated after the commit, so no table lock is held
-- while the citation corpus is scanned. Each drop is its own statement, so a
-- retry after a partial run replays cleanly.

-- stella-migration-safety: reviewed drop-constraint - replaced below by a
-- strict superset of its accepted values.
ALTER TABLE "case_law_decision_identifiers"
  DROP CONSTRAINT IF EXISTS "case_law_decision_identifiers_type_values";--> statement-breakpoint
ALTER TABLE "case_law_decision_identifiers"
  ADD CONSTRAINT "case_law_decision_identifiers_type_values"
  CHECK ("type" IN (
    'case-number',
    'commission-case-number',
    'ecli',
    'neutral-citation',
    'reporter-citation'
  )) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - replaced below by a
-- strict superset of its accepted values.
ALTER TABLE "case_law_citations"
  DROP CONSTRAINT IF EXISTS "citations_identifier_type_values";--> statement-breakpoint
ALTER TABLE "case_law_citations"
  ADD CONSTRAINT "citations_identifier_type_values"
  CHECK ("identifier_type" IN (
    'case-number',
    'commission-case-number',
    'ecli',
    'neutral-citation',
    'reporter-citation'
  )) NOT VALID;--> statement-breakpoint

-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint

-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
ALTER TABLE "case_law_decision_identifiers"
  VALIDATE CONSTRAINT "case_law_decision_identifiers_type_values";--> statement-breakpoint
ALTER TABLE "case_law_citations"
  VALIDATE CONSTRAINT "citations_identifier_type_values";--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
