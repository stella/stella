-- requires: 20260507130000_mcp_connectors
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "mcp_connector_authorization_reviews" (
  "organization_id" varchar(128) NOT NULL,
  "connector_id" uuid NOT NULL,
  "observed_issuer" text,
  "approved_issuer" text,
  "observed_endpoint_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "approved_endpoint_origins" jsonb,
  "status" text DEFAULT 'needs_reapproval' NOT NULL,
  CONSTRAINT "mcp_authorization_review_status_check" CHECK ("status" IN ('needs_reapproval', 'approved')),
  CONSTRAINT "mcp_authorization_review_approval_check" CHECK ("status" <> 'approved' OR "approved_issuer" IS NOT NULL),
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_authorization_reviews_pk" PRIMARY KEY ("organization_id", "connector_id"),
  CONSTRAINT "mcp_authorization_reviews_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "mcp_authorization_reviews_connector_fk" FOREIGN KEY ("connector_id") REFERENCES "mcp_connectors"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "mcp_connector_authorization_reviews_connector_idx"
  ON "mcp_connector_authorization_reviews" ("connector_id");--> statement-breakpoint
ALTER TABLE "mcp_connector_authorization_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_connector_authorization_reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mcp_connector_authorization_reviews" TO stella;--> statement-breakpoint
CREATE POLICY "organization_select" ON "mcp_connector_authorization_reviews" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "mcp_connector_authorization_reviews" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "mcp_connector_authorization_reviews" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true))) WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "mcp_connector_authorization_reviews" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD COLUMN "refresh_lease_expires_at" timestamptz;--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD COLUMN "refresh_retry_after" timestamptz;

--> statement-breakpoint
ALTER TABLE "mcp_connectors" ADD COLUMN "oauth_confirmed_endpoint_origins" jsonb;
