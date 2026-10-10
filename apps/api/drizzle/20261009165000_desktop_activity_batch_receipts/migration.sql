SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "desktop_time_entry_batches" (
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "idempotency_key" varchar(128) NOT NULL,
  "request_fingerprint" varchar(64),
  "status" text DEFAULT 'committed' NOT NULL,
  "result" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("organization_id", "user_id", "idempotency_key"),
  CONSTRAINT "desktop_time_entry_batches_key_check" CHECK (length("idempotency_key") > 0),
  CONSTRAINT "desktop_time_entry_batches_fingerprint_check" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "desktop_time_entry_batches_status_check" CHECK (
    ("status" = 'committed' AND "request_fingerprint" IS NOT NULL AND "result" IS NOT NULL)
    OR ("status" = 'cancelled' AND "request_fingerprint" IS NULL AND "result" IS NULL)
  )
);--> statement-breakpoint
ALTER TABLE "desktop_time_entry_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "desktop_time_entry_batches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "desktop_time_entry_batches" TO stella;--> statement-breakpoint
CREATE POLICY "user_select" ON "desktop_time_entry_batches" FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)) AND user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "desktop_time_entry_batches" FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)) AND user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "desktop_time_entry_batches" FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)) AND user_id = (SELECT current_setting('app.user_id', true))) WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)) AND user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "desktop_time_entry_batches" FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)) AND user_id = (SELECT current_setting('app.user_id', true)));
