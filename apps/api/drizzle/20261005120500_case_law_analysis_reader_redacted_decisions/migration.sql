-- requires: 20260924153000_case_law_analysis_reader_role
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - narrows the analysis reader's decision visibility to rows without a redaction; no other role or relation changes.
ALTER POLICY "case_law_analysis_reader_read" ON "case_law_decisions"
  USING (redacted_at IS NULL);
