-- requires: 20261022120100_professional_use_acceptance_owner_backfill
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
CREATE POLICY "case_law_search_backfill_failures_owner" ON "case_law_search_backfill_failures" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_search_backfill_failures'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_search_backfill_failures'::regclass));
--> statement-breakpoint
CREATE POLICY "case_law_decision_aliases_owner" ON "case_law_decision_aliases" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_decision_aliases'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_decision_aliases'::regclass));
--> statement-breakpoint
CREATE POLICY "case_law_decision_citation_stats_owner" ON "case_law_decision_citation_stats" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_decision_citation_stats'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_decision_citation_stats'::regclass));
--> statement-breakpoint
CREATE POLICY "case_law_decision_citation_stats_state_owner" ON "case_law_decision_citation_stats_state" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_decision_citation_stats_state'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_decision_citation_stats_state'::regclass));
--> statement-breakpoint
CREATE POLICY "sanctions_sources_owner" ON "sanctions_sources" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_sources'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_sources'::regclass));
--> statement-breakpoint
CREATE POLICY "sanctions_editions_owner" ON "sanctions_editions" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_editions'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_editions'::regclass));
--> statement-breakpoint
CREATE POLICY "sanctions_entry_payloads_owner" ON "sanctions_entry_payloads" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_entry_payloads'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_entry_payloads'::regclass));
--> statement-breakpoint
CREATE POLICY "sanctions_edition_entries_owner" ON "sanctions_edition_entries" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_edition_entries'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_edition_entries'::regclass));
--> statement-breakpoint
CREATE POLICY "sanctions_edition_fanouts_owner" ON "sanctions_edition_fanouts" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_edition_fanouts'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_edition_fanouts'::regclass));
--> statement-breakpoint
CREATE POLICY "soft_law_document_locators_owner" ON "soft_law_document_locators" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_document_locators'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_document_locators'::regclass));
--> statement-breakpoint
CREATE POLICY "soft_law_document_versions_owner" ON "soft_law_document_versions" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_document_versions'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_document_versions'::regclass));
--> statement-breakpoint
CREATE POLICY "soft_law_documents_owner" ON "soft_law_documents" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_documents'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_documents'::regclass));
--> statement-breakpoint
CREATE POLICY "soft_law_sources_owner" ON "soft_law_sources" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_sources'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_sources'::regclass));
--> statement-breakpoint
CREATE POLICY "soft_law_ingestion_attempts_owner" ON "soft_law_ingestion_attempts" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_ingestion_attempts'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_ingestion_attempts'::regclass));
--> statement-breakpoint
CREATE POLICY "legislation_amendment_snapshots_owner" ON "legislation_amendment_snapshots" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legislation_amendment_snapshots'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legislation_amendment_snapshots'::regclass));
--> statement-breakpoint
CREATE POLICY "legislation_amendments_owner" ON "legislation_amendments" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legislation_amendments'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legislation_amendments'::regclass));
