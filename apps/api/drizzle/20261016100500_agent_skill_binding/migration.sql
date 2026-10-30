-- requires: 20261015050000_agent_skill_invocation
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A skill may be bound to one matter, or to one client (every matter whose
-- client_id it is). A bound skill is readable, writable and usable only where
-- the caller reaches that binding. Unbound skills keep both columns null and
-- behave exactly as before.
ALTER TABLE "agent_skills" ADD COLUMN IF NOT EXISTS "bound_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN IF NOT EXISTS "bound_client_id" uuid;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - the constraint is new in this migration, so the guarded drop only makes a replay idempotent; rollback drops the binding columns, which drops the constraint with them
ALTER TABLE "agent_skills" DROP CONSTRAINT IF EXISTS "agent_skills_single_binding_check";--> statement-breakpoint
ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_single_binding_check"
  CHECK (num_nonnulls("bound_workspace_id", "bound_client_id") <= 1) NOT VALID;--> statement-breakpoint

-- Composite references keep a binding inside the skill's organization.
-- The post-deploy online phase validates these through its table gate.
-- stella-migration-safety: reviewed drop-constraint - the constraint is new in this migration, so the guarded drop only makes a replay idempotent; rollback drops the binding columns, which drops the constraint with them
ALTER TABLE "agent_skills" DROP CONSTRAINT IF EXISTS "agent_skills_bound_workspace_fk";--> statement-breakpoint
ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_bound_workspace_fk"
  FOREIGN KEY ("bound_workspace_id", "organization_id")
  REFERENCES "workspaces"("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - the constraint is new in this migration, so the guarded drop only makes a replay idempotent; rollback drops the binding columns, which drops the constraint with them
ALTER TABLE "agent_skills" DROP CONSTRAINT IF EXISTS "agent_skills_bound_client_fk";--> statement-breakpoint
ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_bound_client_fk"
  FOREIGN KEY ("organization_id", "bound_client_id")
  REFERENCES "contacts"("organization_id", "id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

-- Policies, as apps/api/src/db/rls.ts builds them:
-- * reach (agentSkillBindingReachCheck): the matter access rule of
--   workspaceAccessCheck (a pinned workspace id, else the authorized view)
--   applied to the bound matter, or to any matter of the bound client;
-- * write (agentSkillWriteRule): team skills by managers, or by their author
--   when bound to a matter; private skills by their author, client-bound only
--   for a manager; always with reach.
-- Child rows (revisions, proposals, comments, resource reads) select from
-- agent_skills under its own policy, so they inherit the reach.

-- stella-migration-safety: reviewed drop-object - the policy is recreated by the next statement in the same transaction, narrowed by the binding reach and adding only the matter author's write path; rollback restores the previous policy text from 20260925230000_agent_skill_write_policies
DROP POLICY IF EXISTS "agent_skill_select" ON "agent_skills";--> statement-breakpoint
CREATE POLICY "agent_skill_select" ON "agent_skills" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND (scope = 'team' OR user_id = (SELECT current_setting('app.user_id', true)))
  AND (
    (agent_skills.bound_workspace_id IS NULL OR CASE
      WHEN agent_skills.bound_workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
      THEN true
      ELSE agent_skills.bound_workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END)
    AND (agent_skills.bound_client_id IS NULL OR EXISTS (
      SELECT 1 FROM workspaces bound_matter
      WHERE bound_matter.organization_id = agent_skills.organization_id
        AND bound_matter.client_id = agent_skills.bound_client_id
        AND CASE
          WHEN bound_matter.id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
          THEN true
          ELSE bound_matter.id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
        END
    ))
  )
));--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the policy is recreated by the next statement in the same transaction, narrowed by the binding reach and adding only the matter author's write path; rollback restores the previous policy text from 20260925230000_agent_skill_write_policies
DROP POLICY IF EXISTS "agent_skill_insert" ON "agent_skills";--> statement-breakpoint
CREATE POLICY "agent_skill_insert" ON "agent_skills" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    (
      (agent_skills.scope = 'team' AND (
        EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
        OR (agent_skills.bound_workspace_id IS NOT NULL AND agent_skills.user_id = (SELECT current_setting('app.user_id', true)))
      ))
      OR (agent_skills.scope = 'private' AND agent_skills.user_id = (SELECT current_setting('app.user_id', true)) AND (
        agent_skills.bound_client_id IS NULL
        OR EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
      ))
    )
    AND (
    (agent_skills.bound_workspace_id IS NULL OR CASE
      WHEN agent_skills.bound_workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
      THEN true
      ELSE agent_skills.bound_workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END)
    AND (agent_skills.bound_client_id IS NULL OR EXISTS (
      SELECT 1 FROM workspaces bound_matter
      WHERE bound_matter.organization_id = agent_skills.organization_id
        AND bound_matter.client_id = agent_skills.bound_client_id
        AND CASE
          WHEN bound_matter.id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
          THEN true
          ELSE bound_matter.id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
        END
    ))
    )
  )
  )
  AND user_id = (SELECT current_setting('app.user_id', true))
));--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the policy is recreated by the next statement in the same transaction, narrowed by the binding reach and adding only the matter author's write path; rollback restores the previous policy text from 20260925230000_agent_skill_write_policies
DROP POLICY IF EXISTS "agent_skill_update" ON "agent_skills";--> statement-breakpoint
CREATE POLICY "agent_skill_update" ON "agent_skills" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    (
      (agent_skills.scope = 'team' AND (
        EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
        OR (agent_skills.bound_workspace_id IS NOT NULL AND agent_skills.user_id = (SELECT current_setting('app.user_id', true)))
      ))
      OR (agent_skills.scope = 'private' AND agent_skills.user_id = (SELECT current_setting('app.user_id', true)) AND (
        agent_skills.bound_client_id IS NULL
        OR EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
      ))
    )
    AND (
    (agent_skills.bound_workspace_id IS NULL OR CASE
      WHEN agent_skills.bound_workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
      THEN true
      ELSE agent_skills.bound_workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END)
    AND (agent_skills.bound_client_id IS NULL OR EXISTS (
      SELECT 1 FROM workspaces bound_matter
      WHERE bound_matter.organization_id = agent_skills.organization_id
        AND bound_matter.client_id = agent_skills.bound_client_id
        AND CASE
          WHEN bound_matter.id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
          THEN true
          ELSE bound_matter.id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
        END
    ))
    )
  )
)) WITH CHECK ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    (
      (agent_skills.scope = 'team' AND (
        EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
        OR (agent_skills.bound_workspace_id IS NOT NULL AND agent_skills.user_id = (SELECT current_setting('app.user_id', true)))
      ))
      OR (agent_skills.scope = 'private' AND agent_skills.user_id = (SELECT current_setting('app.user_id', true)) AND (
        agent_skills.bound_client_id IS NULL
        OR EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
      ))
    )
    AND (
    (agent_skills.bound_workspace_id IS NULL OR CASE
      WHEN agent_skills.bound_workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
      THEN true
      ELSE agent_skills.bound_workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END)
    AND (agent_skills.bound_client_id IS NULL OR EXISTS (
      SELECT 1 FROM workspaces bound_matter
      WHERE bound_matter.organization_id = agent_skills.organization_id
        AND bound_matter.client_id = agent_skills.bound_client_id
        AND CASE
          WHEN bound_matter.id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
          THEN true
          ELSE bound_matter.id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
        END
    ))
    )
  )
));--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the policy is recreated by the next statement in the same transaction, narrowed by the binding reach and adding only the matter author's write path; rollback restores the previous policy text from 20260925230000_agent_skill_write_policies
DROP POLICY IF EXISTS "agent_skill_delete" ON "agent_skills";--> statement-breakpoint
CREATE POLICY "agent_skill_delete" ON "agent_skills" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    (
      (agent_skills.scope = 'team' AND (
        EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
        OR (agent_skills.bound_workspace_id IS NOT NULL AND agent_skills.user_id = (SELECT current_setting('app.user_id', true)))
      ))
      OR (agent_skills.scope = 'private' AND agent_skills.user_id = (SELECT current_setting('app.user_id', true)) AND (
        agent_skills.bound_client_id IS NULL
        OR EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
      ))
    )
    AND (
    (agent_skills.bound_workspace_id IS NULL OR CASE
      WHEN agent_skills.bound_workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
      THEN true
      ELSE agent_skills.bound_workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END)
    AND (agent_skills.bound_client_id IS NULL OR EXISTS (
      SELECT 1 FROM workspaces bound_matter
      WHERE bound_matter.organization_id = agent_skills.organization_id
        AND bound_matter.client_id = agent_skills.bound_client_id
        AND CASE
          WHEN bound_matter.id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
          THEN true
          ELSE bound_matter.id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
        END
    ))
    )
  )
));--> statement-breakpoint

-- Resource writes follow the skill's write rule (they used to repeat the
-- pre-binding rule inline).
-- stella-migration-safety: reviewed drop-object - the policy is recreated by the next statement in the same transaction, narrowed by the binding reach and adding only the matter author's write path; rollback restores the previous policy text from 20260925230000_agent_skill_write_policies
DROP POLICY IF EXISTS "agent_skill_resource_insert" ON "agent_skill_resources";--> statement-breakpoint
CREATE POLICY "agent_skill_resource_insert" ON "agent_skill_resources" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1 FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_resources.organization_id
      AND (
        (
          (s.scope = 'team' AND (
            EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
            OR (s.bound_workspace_id IS NOT NULL AND s.user_id = (SELECT current_setting('app.user_id', true)))
          ))
          OR (s.scope = 'private' AND s.user_id = (SELECT current_setting('app.user_id', true)) AND (
            s.bound_client_id IS NULL
            OR EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
          ))
        )
        AND (
        (s.bound_workspace_id IS NULL OR CASE
          WHEN s.bound_workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
          THEN true
          ELSE s.bound_workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
        END)
        AND (s.bound_client_id IS NULL OR EXISTS (
          SELECT 1 FROM workspaces bound_matter
          WHERE bound_matter.organization_id = s.organization_id
            AND bound_matter.client_id = s.bound_client_id
            AND CASE
              WHEN bound_matter.id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
              THEN true
              ELSE bound_matter.id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
            END
        ))
        )
      )
  )
));--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the policy is recreated by the next statement in the same transaction, narrowed by the binding reach and adding only the matter author's write path; rollback restores the previous policy text from 20260925230000_agent_skill_write_policies
DROP POLICY IF EXISTS "agent_skill_resource_update" ON "agent_skill_resources";--> statement-breakpoint
CREATE POLICY "agent_skill_resource_update" ON "agent_skill_resources" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1 FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_resources.organization_id
      AND (
        (
          (s.scope = 'team' AND (
            EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
            OR (s.bound_workspace_id IS NOT NULL AND s.user_id = (SELECT current_setting('app.user_id', true)))
          ))
          OR (s.scope = 'private' AND s.user_id = (SELECT current_setting('app.user_id', true)) AND (
            s.bound_client_id IS NULL
            OR EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
          ))
        )
        AND (
        (s.bound_workspace_id IS NULL OR CASE
          WHEN s.bound_workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
          THEN true
          ELSE s.bound_workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
        END)
        AND (s.bound_client_id IS NULL OR EXISTS (
          SELECT 1 FROM workspaces bound_matter
          WHERE bound_matter.organization_id = s.organization_id
            AND bound_matter.client_id = s.bound_client_id
            AND CASE
              WHEN bound_matter.id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
              THEN true
              ELSE bound_matter.id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
            END
        ))
        )
      )
  )
)) WITH CHECK ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1 FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_resources.organization_id
      AND (
        (
          (s.scope = 'team' AND (
            EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
            OR (s.bound_workspace_id IS NOT NULL AND s.user_id = (SELECT current_setting('app.user_id', true)))
          ))
          OR (s.scope = 'private' AND s.user_id = (SELECT current_setting('app.user_id', true)) AND (
            s.bound_client_id IS NULL
            OR EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
          ))
        )
        AND (
        (s.bound_workspace_id IS NULL OR CASE
          WHEN s.bound_workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
          THEN true
          ELSE s.bound_workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
        END)
        AND (s.bound_client_id IS NULL OR EXISTS (
          SELECT 1 FROM workspaces bound_matter
          WHERE bound_matter.organization_id = s.organization_id
            AND bound_matter.client_id = s.bound_client_id
            AND CASE
              WHEN bound_matter.id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
              THEN true
              ELSE bound_matter.id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
            END
        ))
        )
      )
  )
));--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the policy is recreated by the next statement in the same transaction, narrowed by the binding reach and adding only the matter author's write path; rollback restores the previous policy text from 20260925230000_agent_skill_write_policies
DROP POLICY IF EXISTS "agent_skill_resource_delete" ON "agent_skill_resources";--> statement-breakpoint
CREATE POLICY "agent_skill_resource_delete" ON "agent_skill_resources" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1 FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_resources.organization_id
      AND (
        (
          (s.scope = 'team' AND (
            EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
            OR (s.bound_workspace_id IS NOT NULL AND s.user_id = (SELECT current_setting('app.user_id', true)))
          ))
          OR (s.scope = 'private' AND s.user_id = (SELECT current_setting('app.user_id', true)) AND (
            s.bound_client_id IS NULL
            OR EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))
          ))
        )
        AND (
        (s.bound_workspace_id IS NULL OR CASE
          WHEN s.bound_workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
          THEN true
          ELSE s.bound_workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
        END)
        AND (s.bound_client_id IS NULL OR EXISTS (
          SELECT 1 FROM workspaces bound_matter
          WHERE bound_matter.organization_id = s.organization_id
            AND bound_matter.client_id = s.bound_client_id
            AND CASE
              WHEN bound_matter.id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
              THEN true
              ELSE bound_matter.id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
            END
        ))
        )
      )
  )
));
