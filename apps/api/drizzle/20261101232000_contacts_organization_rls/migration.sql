-- requires: 20261030044733_case_law_extraction_warnings_generation
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "contacts_owner_organization_access" ON "contacts" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.contacts'::regclass) AND organization_id = (SELECT current_setting('app.organization_id', true))) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.contacts'::regclass) AND organization_id = (SELECT current_setting('app.organization_id', true)));
