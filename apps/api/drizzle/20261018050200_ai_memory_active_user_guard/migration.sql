-- requires: 20261018050100_ai_memory_delete
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - trigger-only function locks at most two exact user references in sorted order, uses fixed qualified names, and revokes PUBLIC execute below
CREATE FUNCTION public.stella_guard_ai_memory_active_users()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  referenced_user_id text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
      OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
    THEN
      RAISE EXCEPTION 'AI memory ownership cannot be reassigned'
        USING ERRCODE = '23514', CONSTRAINT = 'ai_memories_active_user_guard';
    END IF;
    RETURN NEW;
  END IF;

  -- SHARE conflicts with account deletion's NO KEY UPDATE lock. KEY SHARE
  -- would allow a writer to pass that fence. Lock references in one order.
  FOR referenced_user_id IN
    SELECT DISTINCT ref.id
    FROM pg_catalog.unnest(ARRAY[NEW.user_id, NEW.created_by]::text[]) AS ref(id)
    WHERE ref.id IS NOT NULL
    ORDER BY ref.id
  LOOP
    PERFORM 1 FROM public."user"
    WHERE id = referenced_user_id AND deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'AI memory cannot reference a deleted user'
        USING ERRCODE = '23514', CONSTRAINT = 'ai_memories_active_user_guard';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_guard_ai_memory_active_users() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER stella_guard_ai_memory_active_users
BEFORE INSERT OR UPDATE OF user_id, created_by ON public.ai_memories
FOR EACH ROW EXECUTE FUNCTION public.stella_guard_ai_memory_active_users();
