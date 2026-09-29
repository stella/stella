SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "vat_rates" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "code" varchar(64) NOT NULL,
  "name" varchar(128) NOT NULL,
  "rate_bps" integer NOT NULL,
  "valid_from" date NOT NULL,
  "valid_to" date,
  "archived_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "vat_rates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "vat_rates_rate_bps_check" CHECK ("rate_bps" >= 0),
  CONSTRAINT "vat_rates_validity_check" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")
);--> statement-breakpoint
CREATE INDEX "vat_rates_org_created_idx" ON "vat_rates" USING btree ("organization_id", "created_at", "id") WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "vat_rates_org_code_valid_idx" ON "vat_rates" USING btree ("organization_id", "code", "valid_from") WHERE "archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "vat_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vat_rates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "vat_rates" TO "stella";--> statement-breakpoint
CREATE POLICY "organization_select" ON "vat_rates" AS PERMISSIVE FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "vat_rates" AS PERMISSIVE FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "vat_rates" AS PERMISSIVE FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "vat_rates" AS PERMISSIVE FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));
