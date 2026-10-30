SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Replace the check atomically with its expanded set; existing values remain valid. Failure before commit restores the original check; retry after commit recreates the same expanded check.
ALTER TABLE "account_audit_logs" DROP CONSTRAINT IF EXISTS "account_audit_logs_event_type_check";--> statement-breakpoint
ALTER TABLE "account_audit_logs" ADD CONSTRAINT "account_audit_logs_event_type_check"
  CHECK ("event_type" IN ('account.data_export.requested', 'account.data_export.ready', 'account.data_export.downloaded', 'account.data_export.expired', 'account.sign_in_method.disconnected', 'organization.created')) NOT VALID;
--> statement-breakpoint
CREATE TABLE "organization_creation_requests" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "organization_id" text REFERENCES "organization"("id") ON DELETE cascade,
  "name" text,
  "slug" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "key"),
  CONSTRAINT "organization_creation_requests_result_check" CHECK (("organization_id" IS NULL AND "name" IS NULL AND "slug" IS NULL) OR ("organization_id" IS NOT NULL AND "name" IS NOT NULL AND "slug" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "organization_creation_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_creation_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_creation_requests_owner" ON "organization_creation_requests" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_creation_requests'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_creation_requests'::regclass));

--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "organization_creation_requests" FROM stella;
--> statement-breakpoint
CREATE INDEX "organization_creation_requests_org_idx" ON "organization_creation_requests" ("organization_id");
