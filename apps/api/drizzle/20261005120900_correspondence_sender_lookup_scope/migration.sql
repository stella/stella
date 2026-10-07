-- requires: 20260928090000_correspondence_core
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - explicit approver and reset organization contexts preserve lifecycle operations; tenant sender reads use organization policies and policy changes use forward migrations.
ALTER POLICY "correspondence_allowed_senders_owner_lookup" ON "correspondence_allowed_senders"
USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_allowed_senders'::regclass)
  AND (
    approved_by = nullif(current_setting('app.correspondence_erasure_user_id', true), '')
    OR organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
  )
);
--> statement-breakpoint
CREATE POLICY "correspondence_allowed_senders_owner_review_reset_delete" ON "correspondence_allowed_senders"
FOR DELETE TO public USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_allowed_senders'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
