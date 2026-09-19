SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5min';--> statement-breakpoint

-- One row per judge a decision names, so the scan tracks corpus volume rather
-- than how recently the table was created: the five-second bound every schema
-- change here carries would abort it. Its own migration, so the scan holds
-- only SHARE UPDATE EXCLUSIVE on this table, and a timeout fails this
-- statement alone and is retried by rerunning it.
ALTER TABLE "case_law_decision_judges"
  VALIDATE CONSTRAINT "case_law_decision_judges_role_values";
