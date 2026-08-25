SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Better Auth 1.7 bridge schema. This migration is additive so the current
-- 1.6 image remains deployable throughout rehearsal and rollback. Account
-- identities and OAuth resource policy are populated by the separately gated,
-- private-manifest backfill; no existing auth value changes here.
ALTER TABLE "account"
  ADD COLUMN "issuer" text;--> statement-breakpoint

ALTER TABLE "oauth_client"
  ADD COLUMN "client_discovery_id" text,
  ADD COLUMN "client_credentials_scopes" text[] DEFAULT '{}' NOT NULL,
  ADD COLUMN "backchannel_logout_uri" text,
  ADD COLUMN "backchannel_logout_session_required" boolean,
  ADD COLUMN "application_type" text,
  ADD COLUMN "jwks" text,
  ADD COLUMN "jwks_uri" text,
  ADD COLUMN "dpop_bound_access_tokens" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "oauth_refresh_token"
  ADD COLUMN "authorization_code_id" text,
  ADD COLUMN "resources" text[],
  ADD COLUMN "requested_user_info_claims" text[],
  ADD COLUMN "rotated_at" timestamptz,
  ADD COLUMN "rotation_replay_response" text,
  ADD COLUMN "rotation_replay_expires_at" timestamptz,
  ADD COLUMN "confirmation" jsonb;--> statement-breakpoint

ALTER TABLE "oauth_access_token"
  ADD COLUMN "authorization_code_id" text,
  ADD COLUMN "resources" text[],
  ADD COLUMN "requested_user_info_claims" text[],
  ADD COLUMN "revoked" timestamptz,
  ADD COLUMN "confirmation" jsonb;--> statement-breakpoint

ALTER TABLE "oauth_consent"
  ADD COLUMN "resources" text[],
  ADD COLUMN "requested_user_info_claims" text[];--> statement-breakpoint

CREATE TABLE "oauth_resource" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "access_token_ttl" integer,
  "refresh_token_ttl" integer,
  "signing_algorithm" text,
  "signing_key_id" text,
  "allowed_scopes" text[],
  "custom_claims" jsonb,
  "dpop_bound_access_tokens_required" boolean DEFAULT false NOT NULL,
  "disabled" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "policy_version" integer DEFAULT 1 NOT NULL,
  "metadata" jsonb
);--> statement-breakpoint

CREATE TABLE "oauth_client_resource" (
  "id" text PRIMARY KEY,
  "client_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_client_resource_client_id_resource_id_unique"
    UNIQUE ("client_id", "resource_id"),
  CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id")
    ON DELETE CASCADE,
  CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk"
    FOREIGN KEY ("resource_id") REFERENCES "oauth_resource"("identifier")
    ON DELETE CASCADE
);--> statement-breakpoint

CREATE TABLE "oauth_client_assertion" (
  "id" text PRIMARY KEY,
  "expires_at" timestamptz NOT NULL
);--> statement-breakpoint

CREATE INDEX "oauth_refresh_token_authorization_code_id_idx"
  ON "oauth_refresh_token" ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_authorization_code_id_idx"
  ON "oauth_access_token" ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauth_client_resource_client_id_idx"
  ON "oauth_client_resource" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_client_resource_resource_id_idx"
  ON "oauth_client_resource" ("resource_id");--> statement-breakpoint

ALTER TABLE "oauth_resource" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_client_assertion" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "auth_no_stella_access" ON "oauth_resource"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "oauth_client_resource"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "oauth_client_assertion"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE "oauth_resource" FROM "stella";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "oauth_client_resource" FROM "stella";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "oauth_client_assertion" FROM "stella";
