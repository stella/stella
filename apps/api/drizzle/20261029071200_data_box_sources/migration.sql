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

-- The following migration installs this new relation's generated gate graph,
-- policies and write trigger before application traffic can use the table.

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
CREATE TRIGGER register_uploaded_correspondence_source
AFTER INSERT ON "correspondence" FOR EACH ROW
EXECUTE FUNCTION public.register_uploaded_correspondence_source();--> statement-breakpoint

-- Source deletion is a record transition, serialized by the record row. A
-- correspondence cascade may already have removed the parent; then no work
-- remains. Replacing the current source preserves its envelope and attachments.
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
  IF next_source IS NULL THEN
    DELETE FROM public.correspondence
    WHERE id = OLD.correspondence_id AND workspace_id = OLD.workspace_id;
  ELSE
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

-- One transition owns every uploaded channel and retirement. Enroll persisted
-- upload pointers lazily through the indexed source lookup before detaching.
CREATE FUNCTION public.transition_correspondence_source(
  source_organization_id text, source_workspace_id uuid, source_entity uuid,
  target_dedup_key text, target_content_hash text
) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.correspondence_sources (organization_id, workspace_id, correspondence_id, entity_id)
  SELECT c.organization_id, c.workspace_id, c.id, c.source_entity_id
  FROM public.correspondence c
  WHERE c.organization_id = source_organization_id
    AND c.workspace_id = source_workspace_id
    AND c.source_entity_id = source_entity
    AND c.source = 'upload'
  ON CONFLICT DO NOTHING;

  DELETE FROM public.correspondence_sources s
  USING public.correspondence c
  WHERE s.organization_id = source_organization_id
    AND s.workspace_id = source_workspace_id
    AND s.entity_id = source_entity
    AND c.id = s.correspondence_id AND c.workspace_id = s.workspace_id
    AND c.organization_id = s.organization_id
    AND (c.dedup_key IS DISTINCT FROM target_dedup_key
      OR (target_content_hash IS NOT NULL AND c.content_hash IS DISTINCT FROM target_content_hash));
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.transition_uploaded_correspondence_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.source = 'upload' THEN
    PERFORM public.transition_correspondence_source(
      NEW.organization_id, NEW.workspace_id, NEW.source_entity_id, NEW.dedup_key,
      CASE WHEN NEW.channel = 'email' THEN NEW.content_hash ELSE NULL END);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER transition_uploaded_correspondence_source
BEFORE INSERT ON "correspondence" FOR EACH ROW
EXECUTE FUNCTION public.transition_uploaded_correspondence_source();--> statement-breakpoint

-- Run before the entity FK checks: unlink this copy, transition its record,
-- then permit deletion. Both uploaded channels share the same lifetime. All
-- entity deletion paths, including folder/workspace cascades, use this protocol.
CREATE FUNCTION public.remove_entity_correspondence_sources() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.transition_correspondence_source(
    w.organization_id, OLD.workspace_id, OLD.id, NULL, NULL)
  FROM public.workspaces w WHERE w.id = OLD.workspace_id;
  DELETE FROM public.correspondence_sources
  WHERE entity_id = OLD.id AND workspace_id = OLD.workspace_id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER remove_entity_correspondence_sources
BEFORE DELETE ON "entities" FOR EACH ROW
EXECUTE FUNCTION public.remove_entity_correspondence_sources();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - replace the first-file cascade with a restricting FK after installing the source deletion protocol; uploaded email deletion remains handled by the same protocol
ALTER TABLE "correspondence" DROP CONSTRAINT "correspondence_source_entity_workspace_fk";--> statement-breakpoint
-- squawk-ignore adding-foreign-key-constraint -- NOT VALID keeps the live-table validation scan out of the DDL lock window
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_source_entity_workspace_fk" FOREIGN KEY ("source_entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE restrict NOT VALID;
