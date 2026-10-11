SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "desktop_device_proof_replays" (
  "jkt" text NOT NULL,
  "jti" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "desktop_device_proof_replays_pkey" PRIMARY KEY ("jkt", "jti")
);--> statement-breakpoint
CREATE INDEX "desktop_device_proof_replays_expiry_idx" ON "desktop_device_proof_replays" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "desktop_device_proof_replays" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "desktop_device_proof_replays" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "desktop_device_proof_replays_owner_access" ON "desktop_device_proof_replays" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_device_proof_replays'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_device_proof_replays'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "desktop_device_proof_replays" FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_device_proof_replays" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_device_proof_replays" FROM stella;
