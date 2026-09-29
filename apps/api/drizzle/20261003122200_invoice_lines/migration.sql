SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Invoice details. Every new column is nullable, so adding them does not
-- rewrite existing rows. A NULL net_amount marks an invoice whose totals were
-- written before invoice lines; the next totals recalculation fills both
-- amounts, and reads derive them until then.
ALTER TABLE "invoices"
  ADD COLUMN "taxable_supply_date" date,
  ADD COLUMN "seller_profile_id" uuid,
  ADD COLUMN "buyer_name" varchar(512),
  ADD COLUMN "buyer_registration_id" varchar(64),
  ADD COLUMN "buyer_vat_id" varchar(64),
  ADD COLUMN "buyer_address_line_1" varchar(512),
  ADD COLUMN "buyer_address_line_2" varchar(512),
  ADD COLUMN "buyer_city" varchar(256),
  ADD COLUMN "buyer_postal_code" varchar(32),
  ADD COLUMN "buyer_country" varchar(128),
  ADD COLUMN "net_amount" bigint,
  ADD COLUMN "vat_amount" bigint;--> statement-breakpoint

-- Validated by the following migration, outside this DDL transaction.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_seller_profile_id_seller_profiles_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint

CREATE TABLE "invoice_lines" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "invoice_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "description" text NOT NULL,
  "quantity" numeric(18, 4) NOT NULL,
  "unit" varchar(32),
  "unit_price" bigint NOT NULL,
  "vat_rate_bps" integer NOT NULL,
  "vat_treatment" text NOT NULL,
  "net_amount" bigint NOT NULL,
  "vat_amount" bigint NOT NULL,
  "gross_amount" bigint NOT NULL,
  "source" text NOT NULL,
  "time_entry_id" uuid,
  "expense_id" uuid,
  "released_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "invoice_lines_source_check" CHECK ("source" in ('manual', 'time_entry', 'expense')),
  CONSTRAINT "invoice_lines_source_reference_check" CHECK (("source" = 'manual' AND "time_entry_id" IS NULL AND "expense_id" IS NULL) OR ("source" = 'time_entry' AND ("time_entry_id" IS NOT NULL OR "released_at" IS NOT NULL) AND "expense_id" IS NULL) OR ("source" = 'expense' AND ("expense_id" IS NOT NULL OR "released_at" IS NOT NULL) AND "time_entry_id" IS NULL)),
  CONSTRAINT "invoice_lines_vat_treatment_check" CHECK ("vat_treatment" in ('domestic_vat', 'not_vat_payer', 'reverse_charge', 'exempt')),
  CONSTRAINT "invoice_lines_vat_rate_check" CHECK ("vat_rate_bps" between 0 and 10000),
  CONSTRAINT "invoice_lines_amounts_check" CHECK ("quantity" >= 0 AND "unit_price" >= 0 AND "net_amount" >= 0 AND "vat_amount" >= 0 AND "gross_amount" = "net_amount" + "vat_amount"),
  CONSTRAINT "invoice_lines_position_check" CHECK ("position" >= 0),
  CONSTRAINT "invoice_lines_description_check" CHECK (length("description") between 1 and 10000)
);--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_time_entry_id_time_entries_id_fk" FOREIGN KEY ("time_entry_id") REFERENCES "public"."time_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_position_idx" ON "invoice_lines" USING btree ("invoice_id","position","id");--> statement-breakpoint
CREATE INDEX "invoice_lines_time_entry_idx" ON "invoice_lines" USING btree ("time_entry_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_expense_idx" ON "invoice_lines" USING btree ("expense_id");--> statement-breakpoint

-- A time entry or expense is billed by at most one line whose invoice is not
-- void; voiding stamps released_at on the invoice's lines. A released line
-- keeps its snapshot when its source is later deleted (ON DELETE SET NULL);
-- the check keeps an unreleased line tied to its source.
CREATE UNIQUE INDEX "invoice_lines_time_entry_billed_uidx" ON "invoice_lines" USING btree ("time_entry_id") WHERE "time_entry_id" IS NOT NULL AND "released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_expense_billed_uidx" ON "invoice_lines" USING btree ("expense_id") WHERE "expense_id" IS NOT NULL AND "released_at" IS NULL;--> statement-breakpoint

ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "invoice_lines" TO "stella";--> statement-breakpoint
CREATE POLICY "invoice_lines_workspace_select" ON "invoice_lines" FOR SELECT TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "invoice_lines_workspace_insert" ON "invoice_lines" FOR INSERT TO "stella" WITH CHECK (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "invoice_lines_workspace_update" ON "invoice_lines" FOR UPDATE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "invoice_lines_workspace_delete" ON "invoice_lines" FOR DELETE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));
