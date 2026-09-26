SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Proposals and comments anchor to a skill's latest revision. The revision
-- trigger coalesces a save into that revision only while nothing references
-- it, and every save updates the skill row, so a share lock on the skill row
-- keeps saves out until the anchor commits. Members who may propose cannot
-- lock a team skill row themselves (its update policy admits managers only),
-- so this function checks the caller can see the skill, with the predicate of
-- the agent_skills select policy, and takes the lock on their behalf.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked and granted to the app role only; it writes nothing and share-locks one agent_skills row the caller can already see, refusing any other
CREATE FUNCTION "lock_agent_skill_for_anchor"(p_skill_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
    FROM public.agent_skills s
   WHERE s.id = p_skill_id
     AND s.organization_id = current_setting('app.organization_id', true)
     AND (s.scope = 'team' OR s.user_id = current_setting('app.user_id', true))
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent skill is not visible to the caller'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "lock_agent_skill_for_anchor"(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "lock_agent_skill_for_anchor"(uuid) TO stella;--> statement-breakpoint
