SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Serialize every memory ownership reference against account deletion. A writer
-- that locks the user first commits before the deletion sweep; a writer that
-- arrives after deletion waits, then observes deleted_at and fails closed.
-- stella-migration-safety: reviewed security-definer - trigger-only function reads and key-share-locks an exact auth user through fixed qualified names; PUBLIC execute is revoked below; rollback drops the trigger and function.
CREATE FUNCTION public.stella_guard_ai_memory_active_users()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Ownership is immutable after insert except for clearing creator attribution
  -- during account deletion. Reject restoration without taking a user lock: an
  -- UPDATE already holds the memory row, while deletion locks in user -> memory
  -- order, so locking the user here would invert that order.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
      OR (
        NEW.created_by IS DISTINCT FROM OLD.created_by
        AND NEW.created_by IS NOT NULL
      )
    THEN
      RAISE EXCEPTION 'AI memory ownership cannot be reassigned'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'ai_memories_active_user_guard';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.user_id IS NOT NULL THEN
    PERFORM 1
    FROM public."user"
    WHERE id = NEW.user_id
      AND deleted_at IS NULL
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'AI memory cannot reference a deleted user'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'ai_memories_active_user_guard';
    END IF;
  END IF;

  IF NEW.created_by IS NOT NULL
    AND NEW.created_by IS DISTINCT FROM NEW.user_id
  THEN
    PERFORM 1
    FROM public."user"
    WHERE id = NEW.created_by
      AND deleted_at IS NULL
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'AI memory cannot reference a deleted creator'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'ai_memories_active_user_guard';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_guard_ai_memory_active_users()
  FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER stella_guard_ai_memory_active_users
BEFORE INSERT OR UPDATE OF user_id, created_by ON public.ai_memories
FOR EACH ROW
EXECUTE FUNCTION public.stella_guard_ai_memory_active_users();
