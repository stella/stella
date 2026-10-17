SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
CREATE TABLE "account_exports" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE restrict,
  "status" text NOT NULL DEFAULT 'requested',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "claim_token" uuid,
  "lease_expires_at" timestamptz,
  "object_key" text,
  "attempt_object_keys" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "account_exports_status_check" CHECK ("status" IN ('requested', 'processing', 'ready', 'failed', 'expired')),
  CONSTRAINT "account_exports_attempt_check" CHECK ("attempt_count" BETWEEN 0 AND 5 AND jsonb_array_length("attempt_object_keys") <= 5),
  CONSTRAINT "account_exports_state_check" CHECK (
    ("status" = 'processing' AND "claim_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "object_key" IS NOT NULL AND "expires_at" IS NULL)
    OR ("status" = 'ready' AND "claim_token" IS NULL AND "lease_expires_at" IS NULL AND "object_key" IS NOT NULL AND "expires_at" IS NOT NULL)
    OR ("status" IN ('requested', 'failed', 'expired') AND "claim_token" IS NULL AND "lease_expires_at" IS NULL AND "object_key" IS NULL AND "expires_at" IS NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX "account_exports_user_active_idx" ON "account_exports" ("user_id") WHERE "status" IN ('requested', 'processing', 'ready');--> statement-breakpoint
CREATE INDEX "account_exports_user_created_idx" ON "account_exports" ("user_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX "account_exports_recovery_idx" ON "account_exports" ("status", "id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "account_exports" TO stella;--> statement-breakpoint
ALTER TABLE "account_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_exports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "account_exports_select" ON "account_exports" FOR SELECT TO stella USING ("user_id" = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "account_exports_insert" ON "account_exports" FOR INSERT TO stella WITH CHECK ("user_id" = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "account_exports_update" ON "account_exports" FOR UPDATE TO stella USING ("user_id" = (SELECT current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "account_exports_owner" ON "account_exports" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.account_exports'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.account_exports'::regclass));
