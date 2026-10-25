SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "billing_arrangements" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.billing_arrangements'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "billing_arrangements" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.billing_arrangements'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "correspondence_allowed_sender_matters" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_allowed_sender_matters'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "correspondence_allowed_sender_matters" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_allowed_sender_matters'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "correspondence_drop_logs" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_drop_logs'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "correspondence_drop_logs" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_drop_logs'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "invoice_lines" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoice_lines'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "invoice_lines" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoice_lines'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "number_series" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.number_series'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "number_series" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.number_series'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "number_series_allocations" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.number_series_allocations'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "number_series_allocations" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.number_series_allocations'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "number_series_counters" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.number_series_counters'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "number_series_counters" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.number_series_counters'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "seller_profiles" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.seller_profiles'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "seller_profiles" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.seller_profiles'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "vat_rates" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.vat_rates'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "vat_rates" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.vat_rates'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);
