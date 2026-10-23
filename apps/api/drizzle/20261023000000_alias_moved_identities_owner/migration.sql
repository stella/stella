-- requires: 20261022120100_professional_use_acceptance_owner_backfill
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE POLICY "case_law_decision_alias_moved_identities_owner" ON "case_law_decision_alias_moved_identities" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_decision_alias_moved_identities'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_decision_alias_moved_identities'::regclass));
