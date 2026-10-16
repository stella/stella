SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - Atomic cutover of the unused delegated connection schema and all consumers.
ALTER TABLE "sharepoint_connections" RENAME TO "microsoft365_connections";--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - Atomic cutover of the unused delegated connection schema and all consumers.
ALTER TABLE "sharepoint_oauth_state" RENAME TO "microsoft365_oauth_state";--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - Atomic cutover of the unused delegated connection schema and all consumers.
ALTER TABLE "organization_settings" RENAME COLUMN "sharepoint_connection_enabled" TO "microsoft365_connection_enabled";--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "microsoft365_files_read_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "microsoft365_calendar_read_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- stella-migration-safety: reviewed unbounded-update - Small organization settings backfill preserves the existing file access opt-in.
UPDATE "organization_settings" SET "microsoft365_files_read_enabled" = "microsoft365_connection_enabled";--> statement-breakpoint
ALTER TABLE "microsoft365_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "microsoft365_oauth_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Rename preserves the existing organization and user predicates.
ALTER POLICY "sharepoint_connection_select" ON "microsoft365_connections" RENAME TO "microsoft365_connection_select";
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Rename preserves the existing organization and user predicates.
ALTER POLICY "sharepoint_connection_insert" ON "microsoft365_connections" RENAME TO "microsoft365_connection_insert";
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Rename preserves the existing organization and user predicates.
ALTER POLICY "sharepoint_connection_update" ON "microsoft365_connections" RENAME TO "microsoft365_connection_update";
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Rename preserves the existing organization and user predicates.
ALTER POLICY "sharepoint_connection_delete" ON "microsoft365_connections" RENAME TO "microsoft365_connection_delete";
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Rename preserves the existing organization and user predicates.
ALTER POLICY "sharepoint_oauth_state_select" ON "microsoft365_oauth_state" RENAME TO "microsoft365_oauth_state_select";
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Rename preserves the existing organization and user predicates.
ALTER POLICY "sharepoint_oauth_state_insert" ON "microsoft365_oauth_state" RENAME TO "microsoft365_oauth_state_insert";
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Rename preserves the existing organization and user predicates.
ALTER POLICY "sharepoint_oauth_state_update" ON "microsoft365_oauth_state" RENAME TO "microsoft365_oauth_state_update";
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Rename preserves the existing organization and user predicates.
ALTER POLICY "sharepoint_oauth_state_delete" ON "microsoft365_oauth_state" RENAME TO "microsoft365_oauth_state_delete";
--> statement-breakpoint
ALTER INDEX "sharepoint_connections_org_user_uidx" RENAME TO "microsoft365_connections_org_user_uidx";
--> statement-breakpoint
ALTER INDEX "sharepoint_connections_org_user_status_idx" RENAME TO "microsoft365_connections_org_user_status_idx";
--> statement-breakpoint
ALTER INDEX "sharepoint_oauth_state_created_idx" RENAME TO "microsoft365_oauth_state_created_idx";
--> statement-breakpoint
ALTER INDEX "sharepoint_oauth_state_org_user_idx" RENAME TO "microsoft365_oauth_state_org_user_idx";
--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - Atomic cutover of the unused delegated connection schema and all consumers.
ALTER TABLE "microsoft365_connections" RENAME CONSTRAINT "sharepoint_connections_organization_id_organization_id_fk" TO "microsoft365_connections_organization_id_organization_id_fk";
--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - Atomic cutover of the unused delegated connection schema and all consumers.
ALTER TABLE "microsoft365_connections" RENAME CONSTRAINT "sharepoint_connections_user_id_user_id_fk" TO "microsoft365_connections_user_id_user_id_fk";
--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - Atomic cutover of the unused delegated connection schema and all consumers.
ALTER TABLE "microsoft365_oauth_state" RENAME CONSTRAINT "sharepoint_oauth_state_organization_id_organization_id_fk" TO "microsoft365_oauth_state_organization_id_organization_id_fk";
--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - Atomic cutover of the unused delegated connection schema and all consumers.
ALTER TABLE "microsoft365_oauth_state" RENAME CONSTRAINT "sharepoint_oauth_state_user_id_user_id_fk" TO "microsoft365_oauth_state_user_id_user_id_fk";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Replace the unused OAuth state update policy with an explicit denial.
DROP POLICY "microsoft365_oauth_state_update" ON "microsoft365_oauth_state";--> statement-breakpoint
CREATE POLICY "microsoft365_oauth_state_update" ON "microsoft365_oauth_state" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false) WITH CHECK (false);
--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - Keep primary-key names aligned with the renamed connection tables.
ALTER TABLE "microsoft365_connections" RENAME CONSTRAINT "sharepoint_connections_pkey" TO "microsoft365_connections_pkey";
--> statement-breakpoint
-- stella-migration-safety: reviewed rename-table-or-column - Keep primary-key names aligned with the renamed connection tables.
ALTER TABLE "microsoft365_oauth_state" RENAME CONSTRAINT "sharepoint_oauth_state_pkey" TO "microsoft365_oauth_state_pkey";
