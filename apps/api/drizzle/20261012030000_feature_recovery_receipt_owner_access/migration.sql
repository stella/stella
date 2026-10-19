-- requires: 20261010005100_signals_flows_enrolments
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Allow the table owner to maintain feature receipts.
CREATE POLICY "pending_scout_emissions_owner_access" ON "pending_scout_emissions" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.pending_scout_emissions'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.pending_scout_emissions'::regclass));--> statement-breakpoint
CREATE POLICY "flow_upload_trigger_intents_owner_access" ON "flow_upload_trigger_intents" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.flow_upload_trigger_intents'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.flow_upload_trigger_intents'::regclass));
