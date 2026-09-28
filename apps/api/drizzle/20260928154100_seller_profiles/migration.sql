SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "seller_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"legal_name" varchar(512) NOT NULL,
	"registration_id" varchar(64),
	"vat_id" varchar(64),
	"address_line_1" varchar(512),
	"address_line_2" varchar(512),
	"city" varchar(256),
	"postal_code" varchar(32),
	"country" varchar(128),
	"iban" varchar(34),
	"bic" varchar(11),
	"account_number" varchar(64),
	"default_currency" varchar(3) NOT NULL,
	"footer_notes" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamptz,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "seller_profiles_currency_check" CHECK ("default_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "seller_profiles_archived_default_check" CHECK ("archived_at" IS NULL OR NOT "is_default")
);
--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD CONSTRAINT "seller_profiles_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "seller_profiles_org_created_idx" ON "seller_profiles" USING btree ("organization_id","created_at","id") WHERE "archived_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "seller_profiles_org_default_uidx" ON "seller_profiles" USING btree ("organization_id") WHERE "is_default" AND "archived_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "seller_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "seller_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_select" ON "seller_profiles" AS PERMISSIVE FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "seller_profiles" AS PERMISSIVE FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "seller_profiles" AS PERMISSIVE FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "seller_profiles" AS PERMISSIVE FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));
