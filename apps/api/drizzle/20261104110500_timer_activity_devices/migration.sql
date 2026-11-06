SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The phones that show the person's running timer on their Lock Screen, one
-- row per sign-in on a phone. A new, empty table: nothing reads it until this
-- release.
CREATE TABLE "timer_activity_devices" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "device_id" uuid NOT NULL,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "environment" text NOT NULL,
  "bundle_id" text NOT NULL,
  "locale" text NOT NULL,
  "link" text NOT NULL,
  "details" boolean NOT NULL,
  "start_token" text,
  "activity_id" text,
  "activity_token" text,
  "started_at" timestamptz,
  "sequence" bigint NOT NULL,
  "signed_out_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "timer_activity_devices_user_id_device_id_pk" PRIMARY KEY ("user_id", "device_id"),
  CONSTRAINT "timer_activity_devices_environment_check" CHECK ("environment" IN ('sandbox', 'production')),
  CONSTRAINT "timer_activity_devices_bundle_id_check" CHECK ("bundle_id" IN ('app.stll.mobile.dev', 'app.stll.mobile.preview', 'app.stll.mobile')),
  CONSTRAINT "timer_activity_devices_locale_check" CHECK (char_length("locale") BETWEEN 2 AND 35),
  CONSTRAINT "timer_activity_devices_link_check" CHECK (char_length("link") BETWEEN 1 AND 200),
  CONSTRAINT "timer_activity_devices_start_token_check" CHECK ("start_token" ~ '^([0-9a-f]{2}){32,100}$'),
  CONSTRAINT "timer_activity_devices_activity_token_check" CHECK ("activity_token" ~ '^([0-9a-f]{2}){32,100}$'),
  CONSTRAINT "timer_activity_devices_sequence_check" CHECK ("sequence" >= 0),
  CONSTRAINT "timer_activity_devices_activity_check" CHECK (("activity_id" IS NULL) = ("activity_token" IS NULL) AND char_length("activity_id") BETWEEN 1 AND 128)
);--> statement-breakpoint
CREATE INDEX "timer_activity_devices_user_org_idx" ON "timer_activity_devices" ("user_id", "organization_id");--> statement-breakpoint
CREATE INDEX "timer_activity_devices_start_token_idx" ON "timer_activity_devices" ("start_token");--> statement-breakpoint
CREATE INDEX "timer_activity_devices_activity_token_idx" ON "timer_activity_devices" ("activity_token");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "timer_activity_devices" TO stella;--> statement-breakpoint
ALTER TABLE "timer_activity_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "timer_activity_devices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- A person reaches only their own phones.
CREATE POLICY "user_select" ON "timer_activity_devices" AS PERMISSIVE FOR SELECT TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "timer_activity_devices" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "timer_activity_devices" AS PERMISSIVE FOR UPDATE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "timer_activity_devices" AS PERMISSIVE FOR DELETE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
-- Row security is forced, so the owning role (activity updates, dead-token
-- cleanup, account deletion) is admitted by name; the app role never is.
CREATE POLICY "timer_activity_devices_owner" ON "timer_activity_devices" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.timer_activity_devices'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.timer_activity_devices'::regclass));
