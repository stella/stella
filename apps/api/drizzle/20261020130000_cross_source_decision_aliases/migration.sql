-- requires: 20261003123000_case_law_decision_aliases
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A republisher's duplicate may retire under the court's canonical row, but
-- only after its publisher identity has moved in the same transaction. This
-- keeps a bare cross-source alias impossible while permitting the repair.
CREATE OR REPLACE FUNCTION public.case_law_decision_alias_validate() RETURNS trigger
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
  IF retired_source IS NOT NULL AND retired_source <> canonical_source AND NOT EXISTS (
    SELECT 1 FROM public.case_law_decision_source_identities
     WHERE source_id = retired_source
       AND decision_id = NEW.canonical_decision_id
  ) THEN
    RAISE EXCEPTION 'Decision alias crosses publisher sources' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
