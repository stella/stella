SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- A held-decision attachment can also be parked for review because its court
-- and docket are held only under another decision date. That basis never
-- names a host: the record waits for a reader with its candidates listed.
-- stella-migration-safety: reviewed drop-constraint - the basis check is immediately replaced by a wider NOT VALID check that also accepts court-docket-other-date; every existing row still satisfies it, and no released writer stores the new basis.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "case_law_held_decision_attachments" DROP CONSTRAINT IF EXISTS "case_law_held_decision_attachments_basis_values";--> statement-breakpoint
ALTER TABLE "case_law_held_decision_attachments" ADD CONSTRAINT "case_law_held_decision_attachments_basis_values" CHECK ("match_basis" IN ('ecli', 'court-docket-date', 'court-docket-other-date')) NOT VALID;--> statement-breakpoint
ALTER TABLE "case_law_held_decision_attachments" ADD CONSTRAINT "case_law_held_decision_attachments_review_shape" CHECK ("match_basis" <> 'court-docket-other-date' OR "host_decision_id" IS NULL) NOT VALID;
