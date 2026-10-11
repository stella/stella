SET lock_timeout = '5s';
SET statement_timeout = '30s';
--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "time_daily_targets" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.time_daily_targets'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "time_daily_targets" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.time_daily_targets'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "time_timers" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.time_timers'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "time_timers" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.time_timers'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "time_timer_confirmations" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.time_timer_confirmations'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "time_timer_confirmations" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.time_timer_confirmations'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "saved_time_narratives" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.saved_time_narratives'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "saved_time_narratives" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.saved_time_narratives'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "time_entry_timer_states" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.time_entry_timer_states'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "time_entry_timer_states" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.time_entry_timer_states'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "desktop_presence" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_presence'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "desktop_presence" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_presence'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "correspondence" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "correspondence" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "correspondence_filers" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_filers'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "correspondence_filers" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_filers'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "correspondence_attachments" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_attachments'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "correspondence_attachments" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_attachments'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Restrictive deletion stays denied to the application; only the table owner can clear the explicitly selected reset organization. Rollback restores USING (false).
ALTER POLICY "events_no_delete" ON "sanctions_screening_events" USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_screening_events'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
