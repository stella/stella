-- requires: 20260510140000_document_rls_role_bootstrap
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

CREATE TABLE "desktop_presence" (
  "user_id" text NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "desktop_id" uuid NOT NULL,
  "version" varchar(64) NOT NULL,
  "protocol" integer NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_presence_pkey" PRIMARY KEY ("user_id", "organization_id", "desktop_id"),
  CONSTRAINT "desktop_presence_protocol_check" CHECK ("protocol" >= 0),
  CONSTRAINT "desktop_presence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade,
  CONSTRAINT "desktop_presence_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX "desktop_presence_user_seen_idx" ON "desktop_presence" ("user_id", "organization_id", "last_seen_at" DESC);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "desktop_presence" TO stella;--> statement-breakpoint
ALTER TABLE "desktop_presence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "desktop_presence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_select" ON "desktop_presence" FOR SELECT TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "desktop_presence" FOR INSERT TO stella
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "desktop_presence" FOR UPDATE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "desktop_presence" FOR DELETE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));
