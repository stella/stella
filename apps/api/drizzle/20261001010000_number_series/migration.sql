SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "number_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"seller_profile_id" uuid,
	"document_type" text NOT NULL,
	"name" varchar(128) NOT NULL,
	"pattern" varchar(128) NOT NULL,
	"padding" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamptz,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "number_series_document_type_check" CHECK ("document_type" IN ('invoice', 'advance', 'credit_note')),
	CONSTRAINT "number_series_padding_check" CHECK ("padding" BETWEEN 1 AND 6),
	CONSTRAINT "number_series_archived_default_check" CHECK ("archived_at" IS NULL OR NOT "is_default")
);--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_seller_profile_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_org_id_uidx" ON "number_series" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "number_series_org_created_idx" ON "number_series" USING btree ("organization_id","created_at","id") WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_org_type_default_uidx" ON "number_series" USING btree ("organization_id","document_type") WHERE "is_default" AND "archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "number_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "number_series" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "number_series" TO "stella";--> statement-breakpoint
CREATE POLICY "organization_select" ON "number_series" AS PERMISSIVE FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "number_series" AS PERMISSIVE FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "number_series" AS PERMISSIVE FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "number_series" AS PERMISSIVE FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE TABLE "number_series_counters" (
	"organization_id" varchar(128) NOT NULL,
	"series_id" uuid NOT NULL,
	"period_key" varchar(128) NOT NULL,
	"last_value" integer NOT NULL,
	CONSTRAINT "number_series_counters_series_id_period_key_pk" PRIMARY KEY("series_id","period_key"),
	CONSTRAINT "number_series_counters_positive_check" CHECK ("last_value" > 0)
);--> statement-breakpoint
ALTER TABLE "number_series_counters" ADD CONSTRAINT "number_series_counters_series_org_fk" FOREIGN KEY ("organization_id","series_id") REFERENCES "public"."number_series"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "number_series_counters_org_idx" ON "number_series_counters" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "number_series_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "number_series_counters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "number_series_counters" TO "stella";--> statement-breakpoint
CREATE POLICY "organization_select" ON "number_series_counters" AS PERMISSIVE FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "number_series_counters" AS PERMISSIVE FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "number_series_counters" AS PERMISSIVE FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "number_series_counters" AS PERMISSIVE FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE TABLE "number_series_allocations" (
	"organization_id" varchar(128) NOT NULL,
	"series_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"number" varchar(64) NOT NULL,
	"issued_at" timestamptz NOT NULL,
	CONSTRAINT "number_series_allocations_organization_id_document_type_number_pk" PRIMARY KEY("organization_id","document_type","number"),
	CONSTRAINT "number_series_allocations_document_type_check" CHECK ("document_type" IN ('invoice', 'advance', 'credit_note'))
);--> statement-breakpoint
ALTER TABLE "number_series_allocations" ADD CONSTRAINT "number_series_allocations_series_org_fk" FOREIGN KEY ("organization_id","series_id") REFERENCES "public"."number_series"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "number_series_allocations_series_idx" ON "number_series_allocations" USING btree ("series_id");--> statement-breakpoint
ALTER TABLE "number_series_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "number_series_allocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "number_series_allocations" TO "stella";--> statement-breakpoint
CREATE POLICY "organization_select" ON "number_series_allocations" AS PERMISSIVE FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "number_series_allocations" AS PERMISSIVE FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "number_series_allocations" AS PERMISSIVE FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "number_series_allocations" AS PERMISSIVE FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));
