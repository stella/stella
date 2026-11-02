SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The devices the mobile app registers for alerts, one row per person and
-- APNs token. A new, empty table: nothing reads it until this release.
CREATE TABLE "push_devices" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "platform" text NOT NULL,
  "token" text NOT NULL,
  "environment" text NOT NULL,
  "bundle_id" text NOT NULL,
  "app_version" text NOT NULL,
  "locale" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "push_devices_user_id_token_pk" PRIMARY KEY ("user_id", "token"),
  CONSTRAINT "push_devices_platform_check" CHECK ("platform" IN ('ios')),
  CONSTRAINT "push_devices_environment_check" CHECK ("environment" IN ('sandbox', 'production')),
  CONSTRAINT "push_devices_bundle_id_check" CHECK ("bundle_id" IN ('app.stll.mobile.dev', 'app.stll.mobile.preview', 'app.stll.mobile')),
  CONSTRAINT "push_devices_token_check" CHECK ("token" ~ '^([0-9a-f]{2}){32,100}$'),
  CONSTRAINT "push_devices_app_version_check" CHECK (char_length("app_version") BETWEEN 1 AND 64),
  CONSTRAINT "push_devices_locale_check" CHECK (char_length("locale") BETWEEN 2 AND 35)
);--> statement-breakpoint
CREATE INDEX "push_devices_user_org_idx" ON "push_devices" ("user_id", "organization_id");--> statement-breakpoint
CREATE INDEX "push_devices_token_idx" ON "push_devices" ("token");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "push_devices" TO stella;--> statement-breakpoint
ALTER TABLE "push_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_devices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- A person reaches only their own devices.
CREATE POLICY "user_select" ON "push_devices" AS PERMISSIVE FOR SELECT TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "push_devices" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "push_devices" AS PERMISSIVE FOR UPDATE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "push_devices" AS PERMISSIVE FOR DELETE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
-- Row security is forced, so the owning role (alert delivery, dead-token
-- cleanup, account deletion) is admitted by name; the app role never is.
CREATE POLICY "push_devices_owner" ON "push_devices" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.push_devices'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.push_devices'::regclass));
