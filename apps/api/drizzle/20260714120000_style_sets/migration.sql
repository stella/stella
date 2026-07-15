SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "style_sets" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"name" varchar(256) NOT NULL,
	"file_name" varchar(256) NOT NULL,
	"s3_key" varchar(512) NOT NULL,
	"cleanup_s3_key" varchar(512),
	"size_bytes" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);--> statement-breakpoint

ALTER TABLE "style_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "style_sets" ADD CONSTRAINT "style_sets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "style_sets" ADD CONSTRAINT "style_sets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE restrict;--> statement-breakpoint
CREATE INDEX "style_sets_organization_id_idx" ON "style_sets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "style_sets_organization_id_updated_at_idx" ON "style_sets" USING btree ("organization_id", "updated_at", "id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "style_sets" TO stella;--> statement-breakpoint

CREATE POLICY "organization_select" ON "style_sets" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "style_sets" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "style_sets" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "style_sets" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
