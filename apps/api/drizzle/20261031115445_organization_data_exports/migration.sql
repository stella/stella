SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- One row per organisation data export: lifecycle, progress, and the parts
-- written to object storage. A new, empty table; no existing rows move.
CREATE TABLE "organization_data_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"requested_by" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"version_scope" text NOT NULL,
	"matters_total" integer DEFAULT 0 NOT NULL,
	"matters_done" integer DEFAULT 0 NOT NULL,
	"bytes_total" bigint DEFAULT 0 NOT NULL,
	"bytes_done" bigint DEFAULT 0 NOT NULL,
	"part_count" integer,
	"plan" jsonb,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"problem_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "organization_data_exports_status_check" CHECK ("organization_data_exports"."status" IN ('queued', 'running', 'ready', 'failed', 'expired')),
	CONSTRAINT "organization_data_exports_version_scope_check" CHECK ("organization_data_exports"."version_scope" IN ('all', 'current'))
);--> statement-breakpoint
ALTER TABLE "organization_data_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_data_exports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_data_exports" ADD CONSTRAINT "organization_data_exports_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_data_exports" ADD CONSTRAINT "organization_data_exports_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_data_exports_one_active_uidx" ON "organization_data_exports" USING btree ("organization_id") WHERE "organization_data_exports"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "organization_data_exports_org_created_idx" ON "organization_data_exports" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
-- State-leading keys serve bounded global maintenance under generic plans;
-- requester predicates are static and keep each queued cohort independently seekable.
CREATE INDEX "organization_data_exports_status_expires_idx" ON "organization_data_exports" USING btree ("status","expires_at","id");--> statement-breakpoint
CREATE INDEX "organization_data_exports_status_heartbeat_idx" ON "organization_data_exports" USING btree ("status","heartbeat_at","id");--> statement-breakpoint
CREATE INDEX "organization_data_exports_queued_requester_idx" ON "organization_data_exports" USING btree ("status","created_at","id") WHERE "organization_data_exports"."requested_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "organization_data_exports_queued_abandoned_idx" ON "organization_data_exports" USING btree ("status","created_at","id") WHERE "organization_data_exports"."requested_by" IS NULL;--> statement-breakpoint
CREATE INDEX "organization_data_exports_requested_by_idx" ON "organization_data_exports" USING btree ("requested_by");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "organization_data_exports" TO stella;--> statement-breakpoint
CREATE POLICY "organization_select" ON "organization_data_exports" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "organization_data_exports" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "organization_data_exports" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "organization_data_exports" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "organization_data_exports" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_data_exports'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "organization_data_exports" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_data_exports'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "maintenance_owner_select" ON "organization_data_exports" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_data_exports'::regclass)
);--> statement-breakpoint
CREATE POLICY "maintenance_owner_update" ON "organization_data_exports" FOR UPDATE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_data_exports'::regclass)
) WITH CHECK (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_data_exports'::regclass)
);
