SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
-- A compactor holds matching session advisory locks while stored raw content
-- can reach a provider, and it locks the thread and membership rows before it
-- releases them. Irreversible authority transitions take the fence first and
-- then lock their rows: they wait for that egress to finish, or commit first
-- and make the compactor's final gate refuse the dispatch.
--
-- These row triggers are database backstops for writers that skip that order,
-- such as foreign-key cascades. PostgreSQL locks the target row before a row
-- trigger runs, so waiting for the fence here would hold the row the fence
-- holder still needs. The backstops therefore never wait: a writer that holds
-- the fence passes (advisory locks are re-entrant in its transaction), and any
-- other writer is refused with lock_not_available and can retry once the
-- egress has finished.
CREATE FUNCTION fence_chat_thread_stored_content_egress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  fenced_thread_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    fenced_thread_id := OLD.id::text;
  ELSIF OLD.used_anonymization IS NOT TRUE
    AND NEW.used_anonymization IS TRUE
  THEN
    fenced_thread_id := NEW.id::text;
  ELSE
    RETURN NEW;
  END IF;

  IF NOT pg_try_advisory_xact_lock(252759219, hashtext(fenced_thread_id)) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'lock_not_available',
      MESSAGE = 'chat thread stored-content egress is in progress',
      DETAIL = format('thread %s', fenced_thread_id),
      HINT = 'Take the chat stored-content egress lock before locking the thread row, or retry after the egress finishes.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fence_chat_thread_stored_content_egress() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER chat_threads_anonymization_egress
BEFORE UPDATE OF used_anonymization ON chat_threads
FOR EACH ROW
EXECUTE FUNCTION fence_chat_thread_stored_content_egress();
--> statement-breakpoint
CREATE TRIGGER chat_threads_delete_egress
BEFORE DELETE ON chat_threads
FOR EACH ROW
EXECUTE FUNCTION fence_chat_thread_stored_content_egress();
--> statement-breakpoint
CREATE FUNCTION fence_chat_owner_stored_content_egress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  owner_organization_id text;
BEGIN
  IF TG_TABLE_NAME = 'member' THEN
    owner_organization_id := OLD.organization_id::text;
  ELSE
    -- A cascade from a workspace deletion runs after the workspace row is
    -- gone, so this lookup finds nothing; the workspace's own backstop has
    -- then already fenced every member before the cascade began.
    SELECT organization_id::text
    INTO owner_organization_id
    FROM public.workspaces
    WHERE id = OLD.workspace_id;
  END IF;

  IF owner_organization_id IS NOT NULL
    AND NOT pg_try_advisory_xact_lock(
      252759220,
      hashtext(owner_organization_id || chr(31) || OLD.user_id::text)
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'lock_not_available',
      MESSAGE = 'chat stored-content egress for this member is in progress',
      DETAIL = format(
        'organization %s, user %s',
        owner_organization_id,
        OLD.user_id::text
      ),
      HINT = 'Take the chat owner stored-content egress lock before locking the membership row, or retry after the egress finishes.';
  END IF;
  RETURN OLD;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fence_chat_owner_stored_content_egress() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER organization_member_delete_chat_egress
BEFORE DELETE ON member
FOR EACH ROW
EXECUTE FUNCTION fence_chat_owner_stored_content_egress();
--> statement-breakpoint
CREATE TRIGGER workspace_member_delete_chat_egress
BEFORE DELETE ON workspace_members
FOR EACH ROW
EXECUTE FUNCTION fence_chat_owner_stored_content_egress();
--> statement-breakpoint
-- Deleting a workspace removes its members' matter access through a cascade
-- that no longer sees the workspace's organization. Fence every member here,
-- while the workspace row still names it, with the same never-wait refusal.
CREATE FUNCTION fence_chat_workspace_stored_content_egress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  busy_user_id text;
BEGIN
  -- One statement tries every member's fence; any that is held refuses.
  SELECT members.user_id
  INTO busy_user_id
  FROM (
    SELECT DISTINCT user_id::text AS user_id
    FROM public.workspace_members
    WHERE workspace_id = OLD.id
  ) AS members
  WHERE NOT pg_try_advisory_xact_lock(
    252759220,
    hashtext(OLD.organization_id::text || chr(31) || members.user_id)
  )
  ORDER BY members.user_id
  LIMIT 1;

  IF busy_user_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'lock_not_available',
      MESSAGE = 'chat stored-content egress for a member of this workspace is in progress',
      DETAIL = format(
        'organization %s, workspace %s, user %s',
        OLD.organization_id::text,
        OLD.id::text,
        busy_user_id
      ),
      HINT = 'Take the chat owner stored-content egress locks of the workspace members before locking the workspace row, or retry after the egress finishes.';
  END IF;
  RETURN OLD;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fence_chat_workspace_stored_content_egress() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER workspace_delete_chat_egress
BEFORE DELETE ON workspaces
FOR EACH ROW
EXECUTE FUNCTION fence_chat_workspace_stored_content_egress();
