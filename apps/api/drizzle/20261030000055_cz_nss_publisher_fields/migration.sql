SET lock_timeout = '5s';
SET statement_timeout = '30s';
--> statement-breakpoint
ALTER TABLE case_law_decisions
  ADD COLUMN nss_reporter_number text,
  ADD COLUMN nss_reporter_year text,
  ADD COLUMN nss_reporter_issue text,
  ADD COLUMN nss_keyword_search_code text,
  ADD COLUMN nss_registry_case_number text,
  ADD COLUMN nss_registry_referral text,
  ADD COLUMN nss_registry_referral_date text,
  ADD COLUMN nss_registry_against_cases text,
  ADD COLUMN nss_registry_status text,
  ADD COLUMN nss_registry_annotation text;
