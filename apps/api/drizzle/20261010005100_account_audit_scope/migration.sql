SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

CREATE TABLE "account_audit_logs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE restrict,
  "event_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "request_metadata" jsonb,
  "group_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "account_audit_logs_event_type_check" CHECK ("event_type" IN ('account.data_export.requested', 'account.data_export.ready', 'account.data_export.downloaded', 'account.data_export.expired'))
);--> statement-breakpoint
CREATE INDEX "account_audit_logs_user_created_id_idx" ON "account_audit_logs" ("user_id", "created_at", "id");--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "account_audit_logs" TO stella;--> statement-breakpoint
ALTER TABLE "account_audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_audit_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "account_audit_logs_select" ON "account_audit_logs" FOR SELECT TO public USING ("user_id" = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "account_audit_logs_insert" ON "account_audit_logs" FOR INSERT TO stella WITH CHECK ("user_id" = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
-- The worker's owning connection may insert an event but receives no read grant.
CREATE POLICY "account_audit_logs_owner_insert" ON "account_audit_logs" FOR INSERT TO public WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.account_audit_logs'::regclass));--> statement-breakpoint
CREATE POLICY "account_audit_logs_no_update" ON "account_audit_logs" AS RESTRICTIVE FOR UPDATE TO public USING (false);--> statement-breakpoint
CREATE POLICY "account_audit_logs_no_delete" ON "account_audit_logs" AS RESTRICTIVE FOR DELETE TO public USING (false);
