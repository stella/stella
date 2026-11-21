-- requires: 20261010212100_reader_answers
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The root account-deletion transaction may remove only the erasing user's
-- private threads. Shared threads remain organization records.
CREATE POLICY "account_erasure_owner_select" ON "legal_reader_answers" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_answers'::regclass)
  AND user_id = nullif(current_setting('app.account_erasure_user_id', true), '')
  AND visibility = 'private'
);--> statement-breakpoint
CREATE POLICY "account_erasure_owner_delete" ON "legal_reader_answers" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_answers'::regclass)
  AND user_id = nullif(current_setting('app.account_erasure_user_id', true), '')
  AND visibility = 'private'
);
