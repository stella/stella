-- requires: 20260728120000_sharepoint_connections
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "organization_settings"
  ADD COLUMN "microsoft365_calendar_read_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sharepoint_oauth_state"
  ADD COLUMN "requested_scope" text;--> statement-breakpoint

ALTER TABLE "sharepoint_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sharepoint_oauth_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - Replace the unused OAuth-state update permission with a restrictive denial; state is consumed by DELETE and never modified.
DROP POLICY "sharepoint_oauth_state_update" ON "sharepoint_oauth_state";--> statement-breakpoint
CREATE POLICY "sharepoint_oauth_state_update" ON "sharepoint_oauth_state"
  AS RESTRICTIVE FOR UPDATE TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint

CREATE POLICY "sharepoint_connections_owner" ON "sharepoint_connections"
  FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.sharepoint_connections'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.sharepoint_connections'::regclass));--> statement-breakpoint
CREATE POLICY "sharepoint_oauth_state_owner" ON "sharepoint_oauth_state"
  FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.sharepoint_oauth_state'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.sharepoint_oauth_state'::regclass));--> statement-breakpoint

-- An older API task writes only the file opt-in when an admin disables the
-- connection. Clear the calendar opt-in too, including false-to-false writes.
-- A selective update names its organization in a transaction-local marker;
-- a marker for another organization cannot exempt this row.
-- Remove this compatibility trigger after older API tasks have drained.
CREATE FUNCTION public."sharepoint_legacy_disable_calendar"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fence$
BEGIN
  IF pg_catalog.current_setting('app.microsoft365_capability_policy_org', true)
       IS DISTINCT FROM NEW.organization_id::text THEN
    NEW.microsoft365_calendar_read_enabled := false;
  END IF;
  RETURN NEW;
END;
$fence$;--> statement-breakpoint

CREATE TRIGGER "sharepoint_legacy_disable_calendar"
BEFORE UPDATE OF "sharepoint_connection_enabled" ON "organization_settings"
FOR EACH ROW
WHEN (NEW."sharepoint_connection_enabled" = false)
EXECUTE FUNCTION public."sharepoint_legacy_disable_calendar"();
