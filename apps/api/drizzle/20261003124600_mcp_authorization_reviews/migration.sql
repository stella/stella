-- requires: 20260507130000_mcp_connectors
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "mcp_connector_authorization_reviews" (
  "organization_id" varchar(128) NOT NULL,
  "connector_id" uuid NOT NULL,
  "observed_issuer" text,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_connector_authorization_reviews_organization_id_connector_id_pk" PRIMARY KEY ("organization_id", "connector_id"),
  CONSTRAINT "mcp_connector_authorization_reviews_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "mcp_connector_authorization_reviews_connector_id_mcp_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "mcp_connectors"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "mcp_connector_authorization_reviews_connector_idx"
  ON "mcp_connector_authorization_reviews" ("connector_id");--> statement-breakpoint
ALTER TABLE "mcp_connector_authorization_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mcp_connector_authorization_reviews" TO stella;--> statement-breakpoint
CREATE POLICY "organization_select" ON "mcp_connector_authorization_reviews" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "mcp_connector_authorization_reviews" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "mcp_connector_authorization_reviews" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "mcp_connector_authorization_reviews" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD COLUMN "refresh_lease_expires_at" timestamptz;--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD COLUMN "refresh_retry_after" timestamptz;
