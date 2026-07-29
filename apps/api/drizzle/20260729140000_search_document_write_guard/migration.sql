SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Serialize projection writes with their authoritative entity row. This keeps
-- an older application instance in a rolling deployment from replacing a
-- current search projection with content built before the latest edit.
CREATE OR REPLACE FUNCTION stella_guard_search_document_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  semantic_updated_at timestamp without time zone;
BEGIN
  SELECT COALESCE(e.updated_at, e.created_at)
  INTO semantic_updated_at
  FROM public.entities e
  WHERE e.id = NEW.entity_id
  FOR UPDATE;

  IF NOT FOUND OR NEW.updated_at IS DISTINCT FROM semantic_updated_at THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup for
-- this migration's own trigger name; no table data is removed.
DROP TRIGGER IF EXISTS search_documents_guard_authoritative_write
ON search_documents;--> statement-breakpoint

CREATE TRIGGER search_documents_guard_authoritative_write
BEFORE INSERT OR UPDATE
ON search_documents
FOR EACH ROW
EXECUTE FUNCTION stella_guard_search_document_write();
