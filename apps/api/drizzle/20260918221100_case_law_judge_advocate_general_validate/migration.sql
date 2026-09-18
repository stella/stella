SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_decision_judges"
  VALIDATE CONSTRAINT "case_law_decision_judges_role_values";
