SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
CREATE TABLE "legal_holds" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "scope_type" text NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE,
  "reason" text NOT NULL,
  "placed_by" text NOT NULL,
  "placed_at" timestamptz DEFAULT now() NOT NULL,
  "released_by" text,
  "released_at" timestamptz,
  "release_reason" text,
  CONSTRAINT "legal_holds_scope_check" CHECK (("scope_type" = 'matter' AND "workspace_id" IS NOT NULL AND "entity_id" IS NULL) OR ("scope_type" = 'entity' AND "entity_id" IS NOT NULL AND "workspace_id" IS NULL)),
  CONSTRAINT "legal_holds_reason_check" CHECK ("reason" ~ '[^[:space:]]'),
  CONSTRAINT "legal_holds_release_check" CHECK (("released_at" IS NULL AND "released_by" IS NULL AND "release_reason" IS NULL) OR ("released_at" IS NOT NULL AND "released_by" IS NOT NULL AND "release_reason" IS NOT NULL AND "release_reason" ~ '[^[:space:]]'))
);--> statement-breakpoint
CREATE INDEX "legal_holds_active_org_idx" ON "legal_holds" ("organization_id", "workspace_id", "entity_id") WHERE "released_at" IS NULL;--> statement-breakpoint
ALTER TABLE "legal_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_holds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "legal_holds" TO stella;--> statement-breakpoint
CREATE POLICY "organization_select" ON "legal_holds" FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "legal_holds" FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "legal_holds" FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "legal_holds" FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "legal_holds_owner_access" ON "legal_holds" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_holds'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_holds'::regclass));

--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN "erasure_report" jsonb NOT NULL DEFAULT '{"retainedMatterContent":[]}'::jsonb;
