SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "mcp_web_handoff" (
  "id" text PRIMARY KEY NOT NULL,
  "code_hash" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "oauth_client_id" text NOT NULL REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
  "consent_id" text NOT NULL REFERENCES "oauth_consent"("id") ON DELETE CASCADE,
  "allowed_paths" text[] NOT NULL,
  "kind" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "confirmation_shown_at" timestamptz,
  "consumed_session_id" text,
  "created_ip_hash" text,
  "consumed_ip_hash" text,
  "ua_hash" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_web_handoff_kind_check" CHECK ("kind" IN ('text', 'click')),
  CONSTRAINT "mcp_web_handoff_allowedPaths_check" CHECK (cardinality("allowed_paths") BETWEEN 1 AND 50),
  CONSTRAINT "mcp_web_handoff_codeHash_check" CHECK ("code_hash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint

ALTER TABLE "mcp_web_handoff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_web_handoff" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "mcp_web_handoff_owner_access" ON "mcp_web_handoff" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.mcp_web_handoff'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.mcp_web_handoff'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "mcp_web_handoff"
  AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE "mcp_web_handoff" FROM stella;--> statement-breakpoint

CREATE UNIQUE INDEX "mcp_web_handoff_codeHash_idx" ON "mcp_web_handoff" ("code_hash");--> statement-breakpoint
CREATE INDEX "mcp_web_handoff_organizationId_consentId_idx" ON "mcp_web_handoff" ("organization_id", "consent_id");--> statement-breakpoint
CREATE INDEX "mcp_web_handoff_consentId_idx" ON "mcp_web_handoff" ("consent_id");--> statement-breakpoint
CREATE INDEX "mcp_web_handoff_userId_idx" ON "mcp_web_handoff" ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_web_handoff_oauthClientId_idx" ON "mcp_web_handoff" ("oauth_client_id");--> statement-breakpoint
CREATE INDEX "mcp_web_handoff_expiresAt_id_idx" ON "mcp_web_handoff" ("expires_at", "id");--> statement-breakpoint

ALTER TABLE "session" ADD COLUMN "origin_consent_id" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "handoff_absolute_expires_at" timestamptz;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_origin_consent_id_oauth_consent_id_fk"
  FOREIGN KEY ("origin_consent_id") REFERENCES "oauth_consent"("id") ON DELETE CASCADE NOT VALID;
