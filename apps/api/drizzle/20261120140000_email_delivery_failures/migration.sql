SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "email_delivery_failures" (
  "address" text PRIMARY KEY NOT NULL,
  "reason" text NOT NULL,
  "failed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "email_delivery_failures_reason_domain" CHECK (reason IN ('tls_required', 'mailbox_missing', 'mailbox_unavailable', 'suppressed', 'other')),
  CONSTRAINT "email_delivery_failures_address_length" CHECK (char_length(address) BETWEEN 3 AND 320)
);--> statement-breakpoint
CREATE INDEX "email_delivery_failures_failed_at_idx" ON "email_delivery_failures" USING btree ("failed_at");--> statement-breakpoint
ALTER TABLE "email_delivery_failures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_delivery_failures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "email_delivery_failures_owner_access" ON "email_delivery_failures" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.email_delivery_failures'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.email_delivery_failures'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "email_delivery_failures" FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "email_delivery_failures" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "email_delivery_failures" FROM stella;
