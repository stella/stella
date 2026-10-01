-- requires: 20261003123000_case_law_decision_aliases
-- requires: 20260823190000_public_law_reader_role
-- Deploy the release declaring these columns permitted before applying this grant.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE POLICY "public_law_reader_access" ON "case_law_decision_aliases"
  FOR SELECT TO stella_public_law_reader USING (true);--> statement-breakpoint
GRANT SELECT (retired_decision_id, canonical_decision_id)
  ON TABLE "case_law_decision_aliases" TO stella_public_law_reader;
