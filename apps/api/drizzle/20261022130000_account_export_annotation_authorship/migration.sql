-- requires: 20261021080000_reader_annotation_verification_claims
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Account export reads are fenced to the transaction's organization and author.
CREATE POLICY "account_export_owner_select" ON "legal_reader_annotations"
  FOR SELECT TO PUBLIC
  USING (
    current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_annotations'::regclass)
    AND organization_id = nullif(current_setting('app.account_export_organization_id', true), '')
    AND user_id = nullif(current_setting('app.account_export_user_id', true), '')
  );
