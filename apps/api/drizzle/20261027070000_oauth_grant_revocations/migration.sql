SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE "oauth_grant_revocations" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "oauth_client_id" text NOT NULL,
  "revoked_at" timestamp with time zone NOT NULL,
  CONSTRAINT "oauth_grant_revocations_pk" PRIMARY KEY ("organization_id", "user_id", "oauth_client_id")
);
--> statement-breakpoint
CREATE INDEX "oauth_grant_revocations_user_revoked_at_idx" ON "oauth_grant_revocations" ("user_id", "revoked_at");
--> statement-breakpoint
ALTER TABLE "oauth_grant_revocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "oauth_grant_revocations" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "oauth_grant_revocations" FROM stella;--> statement-breakpoint
