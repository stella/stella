SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - this wraps the existing table-owner comparison in a scalar SELECT without changing its current_user identity, schema-qualified owner lookup, or access predicate. Tenant, reset, and UPDATE policies stay unchanged. Existing application versions use the same query and policy. A forward ALTER POLICY can restore the unwrapped predicate.
ALTER POLICY "maintenance_owner_select" ON "public"."organization_data_exports"
USING ((SELECT current_user = (
  SELECT pg_catalog.pg_get_userbyid(relowner)
  FROM pg_catalog.pg_class
  WHERE oid = 'public.organization_data_exports'::regclass
)));
