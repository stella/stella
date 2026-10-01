-- requires: 20260516000000_case_law_ingestion_role
-- requires: 20260823190000_public_law_reader_role
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_decision_aliases" (
  "retired_decision_id" uuid PRIMARY KEY,
  "canonical_decision_id" uuid NOT NULL,
  CONSTRAINT "case_law_decision_aliases_canonical_fk" FOREIGN KEY ("canonical_decision_id") REFERENCES "case_law_decisions"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "case_law_decision_aliases_not_self" CHECK ("retired_decision_id" <> "canonical_decision_id")
);--> statement-breakpoint
CREATE INDEX "case_law_decision_aliases_canonical_idx"
  ON "case_law_decision_aliases" ("canonical_decision_id");--> statement-breakpoint
ALTER TABLE "case_law_decision_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_decision_aliases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_decision_aliases"
  FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_decision_aliases"
  FOR SELECT TO stella_public_law_reader USING (true);--> statement-breakpoint
REVOKE ALL ON TABLE "case_law_decision_aliases" FROM PUBLIC, stella;--> statement-breakpoint
GRANT SELECT (retired_decision_id, canonical_decision_id)
  ON TABLE "case_law_decision_aliases" TO stella_public_law_reader;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "case_law_decision_aliases" TO stella_ingestion;--> statement-breakpoint

-- Serialize graph changes before row locks. Only alias writes take this lock,
-- so ordinary decision ingestion and public reads do not serialize.
CREATE FUNCTION public.case_law_decision_alias_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(732104, 1);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER case_law_decision_alias_lock
  BEFORE INSERT OR UPDATE ON "case_law_decision_aliases"
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_law_decision_alias_lock();--> statement-breakpoint

CREATE FUNCTION public.case_law_decision_alias_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  target uuid;
  retired_source uuid;
  canonical_source uuid;
BEGIN
  SELECT canonical_decision_id INTO target FROM public.case_law_decision_aliases
    WHERE retired_decision_id = NEW.canonical_decision_id;
  NEW.canonical_decision_id := coalesce(target, NEW.canonical_decision_id);
  IF NEW.retired_decision_id = NEW.canonical_decision_id THEN
    RAISE EXCEPTION 'Decision alias cycle' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.retired_decision_id <> OLD.retired_decision_id OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'Decision alias identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.canonical_decision_id <> OLD.canonical_decision_id AND NOT EXISTS (
      SELECT 1 FROM public.case_law_decision_aliases
      WHERE retired_decision_id = OLD.canonical_decision_id
        AND canonical_decision_id = NEW.canonical_decision_id
    ) THEN
      RAISE EXCEPTION 'Conflicting decision alias target' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT source_id INTO canonical_source FROM public.case_law_decisions
    WHERE id = NEW.canonical_decision_id FOR KEY SHARE;
  IF canonical_source IS NULL THEN
    RAISE EXCEPTION 'Decision alias target is not live' USING ERRCODE = '23503';
  END IF;
  SELECT source_id INTO retired_source FROM public.case_law_decisions
    WHERE id = NEW.retired_decision_id FOR KEY SHARE;
  IF TG_OP = 'INSERT' AND retired_source IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.case_law_decision_aliases WHERE retired_decision_id = NEW.retired_decision_id
  ) THEN
    RAISE EXCEPTION 'Register decision alias before retirement' USING ERRCODE = '23503';
  END IF;
  IF retired_source IS NOT NULL AND retired_source <> canonical_source THEN
    RAISE EXCEPTION 'Decision alias crosses publisher sources' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER case_law_decision_alias_validate
  BEFORE INSERT OR UPDATE ON "case_law_decision_aliases"
  FOR EACH ROW EXECUTE FUNCTION public.case_law_decision_alias_validate();--> statement-breakpoint

CREATE FUNCTION public.case_law_decision_alias_flatten() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.case_law_decision_aliases
    SET canonical_decision_id = NEW.canonical_decision_id
    WHERE canonical_decision_id = NEW.retired_decision_id;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER case_law_decision_alias_flatten
  AFTER INSERT OR UPDATE ON "case_law_decision_aliases"
  FOR EACH ROW EXECUTE FUNCTION public.case_law_decision_alias_flatten();--> statement-breakpoint
--> statement-breakpoint
-- A worker that resolved publisher identity before retirement must retry,
-- never recreate a retired UUID after its row has been deleted.
CREATE FUNCTION public.case_law_decision_reject_retired_uuid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.case_law_decision_aliases WHERE retired_decision_id = NEW.id) THEN
    RAISE EXCEPTION 'Decision UUID is retired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER case_law_decision_reject_retired_uuid
  BEFORE INSERT OR UPDATE OF id ON "case_law_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.case_law_decision_reject_retired_uuid();
