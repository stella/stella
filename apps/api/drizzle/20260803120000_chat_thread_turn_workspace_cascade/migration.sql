SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- chat_turns duplicates its thread workspace for RLS and active-turn
-- coordination. A global draft (workspace_id NULL) cannot use a composite
-- foreign-key cascade: NULL child keys are not references in PostgreSQL.
-- Keep the duplicate authoritative with the parent update itself instead.
CREATE OR REPLACE FUNCTION public.sync_chat_turn_workspace_from_thread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  expected_turn_count bigint;
  updated_turn_count bigint;
BEGIN
  IF NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
    INTO expected_turn_count
    FROM public.chat_turns
   WHERE thread_id = NEW.id;

  UPDATE public.chat_turns
     SET workspace_id = NEW.workspace_id
   WHERE thread_id = NEW.id;

  GET DIAGNOSTICS updated_turn_count = ROW_COUNT;
  IF updated_turn_count <> expected_turn_count THEN
    RAISE EXCEPTION 'chat turn workspace cascade lost rows for thread %', NEW.id;
  END IF;

  RETURN NEW;
END;
$function$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.sync_chat_turn_workspace_from_thread() FROM PUBLIC;--> statement-breakpoint

-- chat_turns is introduced by the immediately preceding migration and has no
-- production writers until this feature deploys. Keep this small-table index
-- in the same transaction as the authorization trigger so the RLS invariant
-- becomes visible atomically.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS "chat_turns_thread_id_idx" ON public.chat_turns (thread_id);--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - this new, idempotently named trigger is replaced atomically so a retried migration installs the same workspace-cascade behavior; a failed migration transaction restores the prior trigger state.
DROP TRIGGER IF EXISTS chat_thread_workspace_cascade ON public.chat_threads;--> statement-breakpoint
CREATE TRIGGER chat_thread_workspace_cascade
  AFTER UPDATE OF workspace_id ON public.chat_threads
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_chat_turn_workspace_from_thread();
