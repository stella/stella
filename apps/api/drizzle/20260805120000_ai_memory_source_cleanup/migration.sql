-- A memory may be user-scoped while still containing matter-derived data.
-- Erase every such row when any source matter is permanently deleted; the
-- security-definer trigger is the narrow database boundary that can perform
-- this referential cleanup despite the table's archive-only RLS policy.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.stella_delete_source_matter_memories()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.ai_memories
  WHERE organization_id = OLD.organization_id
    AND source_data_workspace_ids @> ARRAY[OLD.id]::uuid[];
  RETURN OLD;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_delete_source_matter_memories() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER stella_delete_source_matter_memories
BEFORE DELETE ON public.workspaces
FOR EACH ROW
EXECUTE FUNCTION public.stella_delete_source_matter_memories();
