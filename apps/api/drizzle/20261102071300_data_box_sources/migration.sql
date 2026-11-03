SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "correspondence_sources" (
  "entity_feature_gate" text DEFAULT 'pending' NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "correspondence_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  CONSTRAINT "correspondence_sources_pkey" PRIMARY KEY ("workspace_id", "entity_id"),
  CONSTRAINT "entity_feature_gate_states_check" CHECK ("entity_feature_gate" IN ('pending', 'open', 'legal-lists', 'missing')),
  CONSTRAINT "entity_feature_gate_ready_check" CHECK ("entity_feature_gate" <> 'pending'),
  CONSTRAINT "correspondence_sources_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE cascade,
  CONSTRAINT "correspondence_sources_record_workspace_fk" FOREIGN KEY ("correspondence_id", "workspace_id") REFERENCES "correspondence"("id", "workspace_id") ON DELETE cascade,
  CONSTRAINT "correspondence_sources_entity_workspace_fk" FOREIGN KEY ("entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX "correspondence_sources_ws_record_entity_idx" ON "correspondence_sources" ("workspace_id", "correspondence_id", "entity_id");--> statement-breakpoint
ALTER TABLE "correspondence_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "public"."correspondence_sources" AS PERMISSIVE FOR SELECT TO PUBLIC USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_sources'::regclass) AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), ''));--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "public"."correspondence_sources" AS PERMISSIVE FOR DELETE TO PUBLIC USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_sources'::regclass) AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), ''));--> statement-breakpoint
CREATE POLICY "correspondence_sources_workspace_select" ON "public"."correspondence_sources" AS PERMISSIVE FOR SELECT TO "stella" USING (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));--> statement-breakpoint
CREATE POLICY "correspondence_sources_workspace_insert" ON "public"."correspondence_sources" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));--> statement-breakpoint
CREATE POLICY "correspondence_sources_workspace_update" ON "public"."correspondence_sources" AS PERMISSIVE FOR UPDATE TO "stella" USING (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));--> statement-breakpoint
CREATE POLICY "correspondence_sources_workspace_delete" ON "public"."correspondence_sources" AS PERMISSIVE FOR DELETE TO "stella" USING (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public."correspondence_sources" TO stella;--> statement-breakpoint

-- The following migration installs this relation's generated feature gate:
-- its gate checks, gate policies and write trigger. Nothing writes this table
-- before then: the source maintenance migration attaches the record and entity
-- triggers of the routines below only once the gate and the private role exist.

CREATE FUNCTION public.register_uploaded_correspondence_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.source = 'upload' THEN
    INSERT INTO public.correspondence_sources (organization_id, workspace_id, correspondence_id, entity_id)
    VALUES (NEW.organization_id, NEW.workspace_id, NEW.id, NEW.source_entity_id);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Source deletion is a record transition, serialized by the record row. A
-- correspondence cascade may already have removed the parent; then no work
-- remains. Link maintenance never deletes correspondence or its user state.
CREATE FUNCTION public.remove_correspondence_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  next_source uuid;
BEGIN
  PERFORM 1 FROM public.correspondence
  WHERE id = OLD.correspondence_id AND workspace_id = OLD.workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;
  SELECT entity_id INTO next_source FROM public.correspondence_sources
  WHERE correspondence_id = OLD.correspondence_id AND workspace_id = OLD.workspace_id
  ORDER BY entity_id LIMIT 1;
  IF next_source IS NOT NULL THEN
    UPDATE public.correspondence
    SET source_entity_id = next_source, updated_at = now()
    WHERE id = OLD.correspondence_id AND workspace_id = OLD.workspace_id
      AND source_entity_id = OLD.entity_id;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER remove_correspondence_source
AFTER DELETE ON "correspondence_sources" FOR EACH ROW
EXECUTE FUNCTION public.remove_correspondence_source();--> statement-breakpoint

-- Run before the entity FK checks: unlink this copy, transition its record,
-- then permit deletion. Both uploaded channels share the same lifetime. All
-- entity deletion paths, including folder/workspace cascades, use this protocol.
CREATE FUNCTION public.remove_entity_correspondence_sources() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.correspondence_sources
  WHERE entity_id = OLD.id AND workspace_id = OLD.workspace_id;
  -- Only deleting the source document may remove its final correspondence.
  DELETE FROM public.correspondence
  WHERE workspace_id = OLD.workspace_id AND source_entity_id = OLD.id;
  RETURN OLD;
END;
$$;
