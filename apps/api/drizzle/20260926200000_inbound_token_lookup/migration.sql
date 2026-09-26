SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- The worker owner may resolve only the exact delivery token before entering its tenant scope.
CREATE POLICY "matter_inbound_addresses_owner_token_lookup" ON "matter_inbound_addresses"
FOR SELECT TO PUBLIC USING (
  current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.matter_inbound_addresses'::regclass))
  AND "token" = current_setting('app.inbound_token', true)
);
