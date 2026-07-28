-- Hand-rolled (drizzle-kit generate requires TTY in this harness).
-- Delegated Microsoft Graph (SharePoint / OneDrive) connection groundwork:
--   * per user+org connection rows with encrypted delegated tokens
--   * short-lived OAuth state consumed by the callback
--   * org-level enablement toggle (fail closed)
--   * additive document-version provenance column
-- All statements are additive and backward-compatible.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "sharepoint_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"user_id" text NOT NULL,
	"access_token_encrypted" bytea NOT NULL,
	"access_token_iv" bytea NOT NULL,
	"refresh_token_encrypted" bytea,
	"refresh_token_iv" bytea,
	"token_type" varchar(40),
	"scope" text,
	"account_label" text,
	"expires_at" timestamp with time zone,
	"status" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sharepoint_connections_status_values_check" CHECK ("status" IN ('connected', 'reconnect_required'))
);
--> statement-breakpoint
CREATE TABLE "sharepoint_oauth_state" (
	"state" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"user_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sharepoint_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sharepoint_oauth_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sharepoint_connections" ADD CONSTRAINT "sharepoint_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sharepoint_connections" ADD CONSTRAINT "sharepoint_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sharepoint_oauth_state" ADD CONSTRAINT "sharepoint_oauth_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sharepoint_oauth_state" ADD CONSTRAINT "sharepoint_oauth_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "sharepoint_connections_org_user_uidx" ON "sharepoint_connections" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "sharepoint_connections_org_user_status_idx" ON "sharepoint_connections" ("organization_id","user_id","status");--> statement-breakpoint
CREATE INDEX "sharepoint_oauth_state_created_idx" ON "sharepoint_oauth_state" ("created_at");--> statement-breakpoint
CREATE INDEX "sharepoint_oauth_state_org_user_idx" ON "sharepoint_oauth_state" ("organization_id","user_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "sharepoint_connections" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "sharepoint_oauth_state" TO stella;--> statement-breakpoint
CREATE POLICY "sharepoint_connection_select" ON "sharepoint_connections" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "sharepoint_connection_insert" ON "sharepoint_connections" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "sharepoint_connection_update" ON "sharepoint_connections" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "sharepoint_connection_delete" ON "sharepoint_connections" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "sharepoint_oauth_state_select" ON "sharepoint_oauth_state" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "sharepoint_oauth_state_insert" ON "sharepoint_oauth_state" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "sharepoint_oauth_state_update" ON "sharepoint_oauth_state" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "sharepoint_oauth_state_delete" ON "sharepoint_oauth_state" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "sharepoint_connection_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_versions" ADD COLUMN "source" jsonb;
