-- requires: 20261027160600_case_law_redaction_retirement
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

CREATE VIEW "case_law_withdrawal_status" AS
SELECT id AS decision_id, 'withdrawn'::text AS status, redacted_at AS withdrawn_at
FROM "case_law_decisions"
WHERE redacted_at IS NOT NULL;--> statement-breakpoint

GRANT SELECT (decision_id, status, withdrawn_at)
ON TABLE "case_law_withdrawal_status" TO "stella_public_law_reader";
