SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "service_oauth_clients" (
  "client_id" text PRIMARY KEY REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "requests_per_minute" integer NOT NULL,
  "daily_budget" integer NOT NULL,
  CONSTRAINT "service_oauth_clients_limits_check" CHECK (
    "requests_per_minute" BETWEEN 1 AND 600 AND "daily_budget" BETWEEN 1 AND 100000
  )
);--> statement-breakpoint
CREATE INDEX "service_oauth_clients_organization_id_idx" ON "service_oauth_clients" ("organization_id");--> statement-breakpoint
ALTER TABLE "service_oauth_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "service_oauth_clients" FOR ALL TO "stella" USING (false) WITH CHECK (false);
