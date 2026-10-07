-- requires: 20260925220000_legal_list_verifications
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

ALTER TABLE "legal_list_fact_details" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "legal_list_fact_details_owner_access"
  ON "legal_list_fact_details" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_fact_details'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_fact_details'::regclass));--> statement-breakpoint

ALTER TABLE "legal_list_item_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "legal_list_item_sources_owner_access"
  ON "legal_list_item_sources" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_item_sources'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_item_sources'::regclass));--> statement-breakpoint

