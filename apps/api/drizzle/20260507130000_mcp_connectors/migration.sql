CREATE TABLE "mcp_connectors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"organization_id" varchar(128),
	"display_name" varchar(160) NOT NULL,
	"description" text NOT NULL,
	"url" text NOT NULL,
	"auth_type" text NOT NULL,
	"is_curated" boolean DEFAULT false NOT NULL,
	"oauth_requested_scopes" text[],
	"allowed_tools" text[],
	"documentation_url" text,
	"token_help_url" text,
	"icon_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"connector_id" uuid NOT NULL,
	"authorization_server_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" bytea,
	"client_secret_iv" bytea,
	"registration_response" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_user_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"connector_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"access_token_encrypted" bytea,
	"access_token_iv" bytea,
	"refresh_token_encrypted" bytea,
	"refresh_token_iv" bytea,
	"static_token_encrypted" bytea,
	"static_token_iv" bytea,
	"token_type" varchar(40),
	"scope" text,
	"expires_at" timestamp,
	"status" text NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_state" (
	"state" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"connector_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"resource_url" text NOT NULL,
	"authorization_server_url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_connectors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_connectors" ADD CONSTRAINT "mcp_connectors_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ADD CONSTRAINT "mcp_oauth_clients_connector_id_mcp_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "mcp_connectors"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ADD CONSTRAINT "mcp_oauth_clients_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD CONSTRAINT "mcp_user_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD CONSTRAINT "mcp_user_connections_connector_id_mcp_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "mcp_connectors"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD CONSTRAINT "mcp_user_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_state" ADD CONSTRAINT "mcp_oauth_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_state" ADD CONSTRAINT "mcp_oauth_state_connector_id_mcp_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "mcp_connectors"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_state" ADD CONSTRAINT "mcp_oauth_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connectors_curated_slug_uidx" ON "mcp_connectors" ("slug") WHERE organization_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connectors_custom_org_slug_uidx" ON "mcp_connectors" ("organization_id","slug") WHERE organization_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "mcp_connectors_org_curated_idx" ON "mcp_connectors" ("organization_id","is_curated");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_clients_org_connector_as_uidx" ON "mcp_oauth_clients" ("organization_id","connector_id","authorization_server_url");
--> statement-breakpoint
CREATE INDEX "mcp_oauth_clients_org_connector_idx" ON "mcp_oauth_clients" ("organization_id","connector_id");
--> statement-breakpoint
CREATE INDEX "mcp_oauth_clients_connector_idx" ON "mcp_oauth_clients" ("connector_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_user_connections_org_connector_user_uidx" ON "mcp_user_connections" ("organization_id","connector_id","user_id");
--> statement-breakpoint
CREATE INDEX "mcp_user_connections_user_status_idx" ON "mcp_user_connections" ("user_id","status");
--> statement-breakpoint
CREATE INDEX "mcp_user_connections_org_user_status_idx" ON "mcp_user_connections" ("organization_id","user_id","status");
--> statement-breakpoint
CREATE INDEX "mcp_user_connections_connector_idx" ON "mcp_user_connections" ("connector_id");
--> statement-breakpoint
CREATE INDEX "mcp_oauth_state_created_idx" ON "mcp_oauth_state" ("created_at");
--> statement-breakpoint
CREATE INDEX "mcp_oauth_state_org_user_idx" ON "mcp_oauth_state" ("organization_id","user_id");
--> statement-breakpoint
CREATE POLICY "mcp_connector_select" ON "mcp_connectors" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id IS NULL OR organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));
--> statement-breakpoint
CREATE POLICY "mcp_connector_insert" ON "mcp_connectors" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));
--> statement-breakpoint
CREATE POLICY "mcp_connector_update" ON "mcp_connectors" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));
--> statement-breakpoint
CREATE POLICY "mcp_connector_delete" ON "mcp_connectors" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));
--> statement-breakpoint
CREATE POLICY "mcp_oauth_client_select" ON "mcp_oauth_clients" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
  SELECT 1 FROM mcp_connectors mc
  WHERE mc.id = connector_id
)));
--> statement-breakpoint
CREATE POLICY "mcp_oauth_client_insert" ON "mcp_oauth_clients" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
  SELECT 1 FROM mcp_connectors mc
  WHERE mc.id = connector_id
)));
--> statement-breakpoint
CREATE POLICY "mcp_oauth_client_update" ON "mcp_oauth_clients" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
  SELECT 1 FROM mcp_connectors mc
  WHERE mc.id = connector_id
)));
--> statement-breakpoint
CREATE POLICY "mcp_oauth_client_delete" ON "mcp_oauth_clients" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
  SELECT 1 FROM mcp_connectors mc
  WHERE mc.id = connector_id
)));
--> statement-breakpoint
CREATE POLICY "mcp_user_connection_select" ON "mcp_user_connections" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
--> statement-breakpoint
CREATE POLICY "mcp_user_connection_insert" ON "mcp_user_connections" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
--> statement-breakpoint
CREATE POLICY "mcp_user_connection_update" ON "mcp_user_connections" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
--> statement-breakpoint
CREATE POLICY "mcp_user_connection_delete" ON "mcp_user_connections" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
--> statement-breakpoint
CREATE POLICY "mcp_oauth_state_select" ON "mcp_oauth_state" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
--> statement-breakpoint
CREATE POLICY "mcp_oauth_state_insert" ON "mcp_oauth_state" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
--> statement-breakpoint
CREATE POLICY "mcp_oauth_state_update" ON "mcp_oauth_state" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
--> statement-breakpoint
CREATE POLICY "mcp_oauth_state_delete" ON "mcp_oauth_state" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
