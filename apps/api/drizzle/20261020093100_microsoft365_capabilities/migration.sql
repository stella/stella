-- requires: 20260728120000_sharepoint_connections
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "microsoft365_files_read_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "microsoft365_calendar_read_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- stella-migration-safety: reviewed unbounded-update - Preserve the existing organization file-access opt-in without changing connection rows or granted scopes.
UPDATE "organization_settings" SET "microsoft365_files_read_enabled" = "sharepoint_connection_enabled";--> statement-breakpoint
ALTER TABLE "sharepoint_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sharepoint_oauth_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Replace the unused OAuth-state update permission with an explicit denial.
DROP POLICY "sharepoint_oauth_state_update" ON "sharepoint_oauth_state";--> statement-breakpoint
CREATE POLICY "sharepoint_oauth_state_update" ON "sharepoint_oauth_state" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false) WITH CHECK (false);

--> statement-breakpoint
CREATE POLICY "sharepoint_connections_owner" ON "sharepoint_connections" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sharepoint_connections'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sharepoint_connections'::regclass));

--> statement-breakpoint
CREATE POLICY "sharepoint_oauth_state_owner" ON "sharepoint_oauth_state" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sharepoint_oauth_state'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sharepoint_oauth_state'::regclass));

--> statement-breakpoint
ALTER TABLE "sharepoint_oauth_state" ADD COLUMN "requested_scope" text;
