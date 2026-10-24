SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
-- A compactor holds matching session advisory locks while stored raw content
-- can reach a provider. Irreversible authority transitions wait for that
-- egress to finish, or commit first and make the compactor's final gate refuse
-- the dispatch. Application paths take these locks before their row writes;
-- the triggers are database backstops for future writers and cascades.
CREATE FUNCTION fence_chat_thread_stored_content_egress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(252759214, hashtext(OLD.id::text));
    RETURN OLD;
  END IF;
  IF OLD.used_anonymization IS NOT TRUE
    AND NEW.used_anonymization IS TRUE
  THEN
    PERFORM pg_advisory_xact_lock(252759214, hashtext(NEW.id::text));
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
    SELECT organization_id::text
    INTO owner_organization_id
    FROM public.workspaces
    WHERE id = OLD.workspace_id;
  END IF;

  IF owner_organization_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      252759215,
      hashtext(owner_organization_id || chr(31) || OLD.user_id::text)
    );
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
