-- requires: 20261017100000_commission_case_number_identifier
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - each check is immediately replaced by a wider NOT VALID constraint while existing values remain accepted.
ALTER TABLE "case_law_citations" DROP CONSTRAINT IF EXISTS "citations_identifier_type_values";--> statement-breakpoint
ALTER TABLE "case_law_citations" ADD CONSTRAINT "citations_identifier_type_values" CHECK ("identifier_type" IN ('authority-decision-number', 'case-number', 'commission-case-number', 'ecli', 'neutral-citation', 'reporter-citation')) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - each check is immediately replaced by a wider NOT VALID constraint while existing values remain accepted.
ALTER TABLE "case_law_decision_identifiers" DROP CONSTRAINT IF EXISTS "case_law_decision_identifiers_type_values";--> statement-breakpoint
ALTER TABLE "case_law_decision_identifiers" ADD CONSTRAINT "case_law_decision_identifiers_type_values" CHECK ("type" IN ('authority-decision-number', 'case-number', 'commission-case-number', 'ecli', 'neutral-citation', 'reporter-citation')) NOT VALID;--> statement-breakpoint

-- Validation scans run outside the migration ledger transaction so they do not hold its locks.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5min';--> statement-breakpoint
ALTER TABLE "case_law_citations" VALIDATE CONSTRAINT "citations_identifier_type_values";--> statement-breakpoint
ALTER TABLE "case_law_decision_identifiers" VALIDATE CONSTRAINT "case_law_decision_identifiers_type_values";--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
