-- requires: 20261021080000_reader_annotation_verification_claims
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- An account export may read only annotations authored by the exporting user
-- in the scoped organization. The export identity is transaction-local and is
-- installed only by the account-export database scope; ordinary application
-- reads continue through the matter-aware organization policy.
CREATE POLICY "account_export_author_select" ON "legal_reader_annotations"
  FOR SELECT TO "stella"
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND user_id = (SELECT current_setting('app.user_id', true))
    AND user_id = (SELECT current_setting('app.account_export_user_id', true))
  );
