SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
CREATE TABLE "legal_holds" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "scope_type" text NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "entity_id" uuid REFERENCES "entities"("id") ON DELETE RESTRICT,
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
GRANT SELECT, INSERT, UPDATE ON TABLE "legal_holds" TO stella;--> statement-breakpoint
REVOKE DELETE ON TABLE "legal_holds" FROM stella;--> statement-breakpoint
CREATE POLICY "organization_select" ON "legal_holds" FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "legal_holds" FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "legal_holds" FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "legal_holds_owner_access" ON "legal_holds" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_holds'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_holds'::regclass));

--> statement-breakpoint
CREATE FUNCTION "legal_hold_delete_backstop"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'workspaces' THEN
    IF EXISTS (
      SELECT 1 FROM public.legal_holds h
      LEFT JOIN public.entities held_entity ON held_entity.id = h.entity_id
      WHERE h.released_at IS NULL
        AND (h.workspace_id = OLD.id OR held_entity.workspace_id = OLD.id)
    ) THEN
      RAISE EXCEPTION 'active legal hold prevents matter deletion' USING ERRCODE = '23503';
    END IF;
    DELETE FROM public.legal_holds WHERE released_at IS NOT NULL AND workspace_id = OLD.id;
  ELSIF TG_TABLE_NAME = 'entities' THEN
    IF EXISTS (
      WITH RECURSIVE descendants AS (
        SELECT OLD.id AS id
        UNION ALL
        SELECT child.id FROM public.entities child
        JOIN descendants parent ON child.parent_id = parent.id
      )
      SELECT 1 FROM public.legal_holds h
      WHERE h.released_at IS NULL
        AND (h.workspace_id = OLD.workspace_id OR h.entity_id IN (SELECT id FROM descendants))
    ) THEN
      RAISE EXCEPTION 'active legal hold prevents item deletion' USING ERRCODE = '23503';
    END IF;
    DELETE FROM public.legal_holds WHERE released_at IS NOT NULL AND entity_id = OLD.id;
  ELSIF TG_TABLE_NAME = 'workspace_contacts' THEN
    IF EXISTS (
      SELECT 1 FROM public.legal_holds h
      LEFT JOIN public.entities held_entity ON held_entity.id = h.entity_id
      WHERE h.released_at IS NULL
        AND (h.workspace_id = OLD.workspace_id OR held_entity.workspace_id = OLD.workspace_id)
    ) THEN
      RAISE EXCEPTION 'active legal hold prevents matter contact deletion' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "legal_hold_delete_backstop"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "legal_hold_workspaces_delete_backstop" BEFORE DELETE ON "workspaces" FOR EACH ROW EXECUTE FUNCTION "legal_hold_delete_backstop"();--> statement-breakpoint
CREATE TRIGGER "legal_hold_entities_delete_backstop" BEFORE DELETE ON "entities" FOR EACH ROW EXECUTE FUNCTION "legal_hold_delete_backstop"();--> statement-breakpoint
CREATE TRIGGER "legal_hold_workspace_contacts_delete_backstop" BEFORE DELETE ON "workspace_contacts" FOR EACH ROW EXECUTE FUNCTION "legal_hold_delete_backstop"();

--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN "erasure_report" jsonb NOT NULL DEFAULT '{"retainedMatterContent":[]}'::jsonb;
