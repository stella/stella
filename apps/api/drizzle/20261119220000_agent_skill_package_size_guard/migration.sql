SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A skill's files together stay within the package size every export fits
-- in (SKILL_PACKAGE_LIMITS.packageFilesMaxBytes in packages/skills, 49 MiB),
-- so any stored skill exports as a package that imports again. Checked once
-- per statement over the skills it wrote, from the stored size_bytes; a
-- refusal raises check_violation naming agent_skill_resources_package_size,
-- which the API answers as a 413. Writers lock the skill row first, so two
-- concurrent writes to one skill are each checked against the other's rows.
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
    HAVING sum(resource.size_bytes) > 51380224
  ) THEN
    RAISE EXCEPTION 'a skill''s files exceed the package size limit'
      USING ERRCODE = 'check_violation',
        CONSTRAINT = 'agent_skill_resources_package_size';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "guard_agent_skill_package_size"() FROM PUBLIC;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the trigger is new in this migration, so the guarded drop only makes a replay idempotent
DROP TRIGGER IF EXISTS "agent_skill_resources_package_size_insert" ON "agent_skill_resources";--> statement-breakpoint
CREATE TRIGGER "agent_skill_resources_package_size_insert"
  AFTER INSERT ON "agent_skill_resources"
  REFERENCING NEW TABLE AS written_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_agent_skill_package_size"();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the trigger is new in this migration, so the guarded drop only makes a replay idempotent
DROP TRIGGER IF EXISTS "agent_skill_resources_package_size_update" ON "agent_skill_resources";--> statement-breakpoint
CREATE TRIGGER "agent_skill_resources_package_size_update"
  AFTER UPDATE ON "agent_skill_resources"
  REFERENCING NEW TABLE AS written_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_agent_skill_package_size"();
