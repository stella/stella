-- requires: 20261120070100_agent_skill_resource_originals
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The triggers that keep a skill file's original honest: a deleted file or
-- a dropped original is queued for erasure, new text drops a stale
-- original, and the package size limit counts originals.

-- Runs as the owner, so whichever role deletes a file (a request, account
-- erasure, an organization's cascade) queues its original without any
-- privilege on the queue.
-- stella-migration-safety: reviewed security-definer - trigger-only function with a fixed search path and PUBLIC execute revoked below; it only inserts the removed rows' original keys into the erasure queue
CREATE OR REPLACE FUNCTION "queue_agent_skill_original_cleanup"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.agent_skill_original_cleanup_requests (organization_id, s3_keys)
    SELECT removed.organization_id,
      pg_catalog.array_agg(removed.original_s3_key ORDER BY removed.original_s3_key)
    FROM removed_rows removed
    WHERE removed.original_s3_key IS NOT NULL
    GROUP BY removed.organization_id;
  ELSE
    INSERT INTO public.agent_skill_original_cleanup_requests (organization_id, s3_keys)
    SELECT removed.organization_id,
      pg_catalog.array_agg(removed.original_s3_key ORDER BY removed.original_s3_key)
    FROM removed_rows removed
    JOIN written_rows written ON written.id = removed.id
    WHERE removed.original_s3_key IS NOT NULL
      AND removed.original_s3_key IS DISTINCT FROM written.original_s3_key
    GROUP BY removed.organization_id;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "queue_agent_skill_original_cleanup"() FROM PUBLIC;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the trigger is new in this migration, so the guarded drop only makes a replay idempotent
DROP TRIGGER IF EXISTS "agent_skill_resources_original_cleanup_delete" ON "agent_skill_resources";--> statement-breakpoint
CREATE TRIGGER "agent_skill_resources_original_cleanup_delete"
  AFTER DELETE ON "agent_skill_resources"
  REFERENCING OLD TABLE AS removed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "queue_agent_skill_original_cleanup"();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the trigger is new in this migration, so the guarded drop only makes a replay idempotent
DROP TRIGGER IF EXISTS "agent_skill_resources_original_cleanup_update" ON "agent_skill_resources";--> statement-breakpoint
CREATE TRIGGER "agent_skill_resources_original_cleanup_update"
  AFTER UPDATE ON "agent_skill_resources"
  REFERENCING OLD TABLE AS removed_rows NEW TABLE AS written_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "queue_agent_skill_original_cleanup"();--> statement-breakpoint

-- New text for a file makes its original stale: the original is dropped
-- (and so queued for erasure) whenever a write changes the text and keeps
-- the same original.
CREATE OR REPLACE FUNCTION "drop_stale_agent_skill_original"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content
    AND NEW.original_s3_key IS NOT DISTINCT FROM OLD.original_s3_key THEN
    NEW.original_s3_key := NULL;
    NEW.original_sha256 := NULL;
    NEW.original_size_bytes := NULL;
    NEW.original_media_type := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "drop_stale_agent_skill_original"() FROM PUBLIC;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the trigger is new in this migration, so the guarded drop only makes a replay idempotent
DROP TRIGGER IF EXISTS "agent_skill_resources_original_staleness" ON "agent_skill_resources";--> statement-breakpoint
CREATE TRIGGER "agent_skill_resources_original_staleness"
  BEFORE UPDATE OF "content" ON "agent_skill_resources"
  FOR EACH ROW
  WHEN (OLD.original_s3_key IS NOT NULL)
  EXECUTE FUNCTION "drop_stale_agent_skill_original"();--> statement-breakpoint

-- The package size limit counts an original's bytes too.
CREATE OR REPLACE FUNCTION "guard_agent_skill_package_size"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.agent_skill_resources resource
    WHERE resource.skill_id IN (SELECT DISTINCT written.skill_id FROM written_rows written)
    GROUP BY resource.skill_id
    HAVING sum(resource.size_bytes + COALESCE(resource.original_size_bytes, 0)) > 51380224
  ) THEN
    RAISE EXCEPTION 'a skill''s files exceed the package size limit'
      USING ERRCODE = 'check_violation',
        CONSTRAINT = 'agent_skill_resources_package_size';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
