-- requires: 20261026220000_client_invoices
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- When an invoice was marked sent, so a paid invoice whose payments are
-- voided returns to the status it had. Nullable and default-free: a catalog
-- change that leaves every existing invoice row as it was.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "sent_at" timestamptz;--> statement-breakpoint

-- Payments a client made towards an issued invoice. Additive: a new, empty
-- table; no existing invoice row or total is read or changed. A payment hangs
-- off its invoice (which outlives its matters) and is reversed by voiding;
-- the application never deletes an issued invoice, so the cascade serves only
-- deliberate removals (organization deletion, the review reset).
CREATE TABLE "invoice_payments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "invoice_id" uuid NOT NULL,
  "amount" bigint NOT NULL,
  "paid_on" date NOT NULL,
  "method" text NOT NULL,
  "reference" varchar(140),
  "note" varchar(1000),
  "recorded_by" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "voided_at" timestamptz,
  "voided_by" text,
  CONSTRAINT "invoice_payments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "invoice_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE,
  CONSTRAINT "invoice_payments_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "invoice_payments_method_check" CHECK ("method" in ('bank_transfer', 'card', 'cash', 'other')),
  CONSTRAINT "invoice_payments_void_check" CHECK (("voided_at" IS NULL) = ("voided_by" IS NULL))
);--> statement-breakpoint

CREATE INDEX "invoice_payments_invoice_idx" ON "invoice_payments" ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_payments_organization_idx" ON "invoice_payments" ("organization_id");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_payments" TO stella;--> statement-breakpoint
ALTER TABLE "invoice_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- A payment is visible and writable only while its invoice is: the invoice's
-- own policy decides whole-invoice access, as for its lines. With the
-- organization policies below this also pairs the tenants, since a visible
-- invoice is always the caller's organization's.
CREATE POLICY "invoice_payments_complete_invoice" ON "invoice_payments" AS RESTRICTIVE FOR ALL TO stella
  USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_id));--> statement-breakpoint
-- Reversal is a void, never a delete.
CREATE POLICY "invoice_payments_no_delete" ON "invoice_payments" AS RESTRICTIVE FOR DELETE TO stella USING (false);--> statement-breakpoint
CREATE POLICY "organization_select" ON "invoice_payments" AS PERMISSIVE FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "invoice_payments" AS PERMISSIVE FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "invoice_payments" AS PERMISSIVE FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "invoice_payments" AS PERMISSIVE FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

-- The review reset clears payments as the table owner, which the forced
-- policies otherwise refuse.
CREATE POLICY "review_reset_owner_select" ON "invoice_payments" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoice_payments'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "invoice_payments" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoice_payments'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint

-- The online backfill (apps/api/src/lib/billing/invoice-payment-backfill.ts) runs as
-- the owner: it reads every payment and inserts only the recorder-less
-- settlement of an invoice marked paid before payment records existed.
CREATE POLICY "invoice_payments_owner_select" ON "invoice_payments" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoice_payments'::regclass)
);--> statement-breakpoint
CREATE POLICY "invoice_payments_owner_backfill_insert" ON "invoice_payments" FOR INSERT TO PUBLIC WITH CHECK (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoice_payments'::regclass)
  AND recorded_by IS NULL
);
