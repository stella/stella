-- requires: 20261016100500_agent_skill_binding
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Rows that hang off a skill (files, revisions, proposals, comments) state
-- the binding reach themselves, as apps/api/src/db/rls.ts builds it
-- (agentSkillChildVisibleCheck), instead of relying on the agent_skills
-- select policy that their subquery runs under.

-- stella-migration-safety: reviewed alter-policy - adds the binding reach that the agent_skills select policy already applies to this subquery, so no row becomes visible or writable that was not before; rollback restores the expression from 20261016100500_agent_skill_binding and earlier
ALTER POLICY "agent_skill_resource_select" ON "agent_skill_resources" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_resources.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - adds the binding reach that the agent_skills select policy already applies to this subquery, so no row becomes visible or writable that was not before; rollback restores the expression from 20261016100500_agent_skill_binding and earlier
ALTER POLICY "agent_skill_revision_select" ON "agent_skill_revisions" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_revisions.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - adds the binding reach that the agent_skills select policy already applies to this subquery, so no row becomes visible or writable that was not before; rollback restores the expression from 20261016100500_agent_skill_binding and earlier
ALTER POLICY "agent_skill_proposal_select" ON "agent_skill_proposals" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_proposals.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - adds the binding reach that the agent_skills select policy already applies to this subquery, so no row becomes visible or writable that was not before; rollback restores the expression from 20261016100500_agent_skill_binding and earlier
ALTER POLICY "agent_skill_proposal_insert" ON "agent_skill_proposals" WITH CHECK ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_proposals.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - adds the binding reach that the agent_skills select policy already applies to this subquery, so no row becomes visible or writable that was not before; rollback restores the expression from 20261016100500_agent_skill_binding and earlier
ALTER POLICY "agent_skill_proposal_update" ON "agent_skill_proposals" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_proposals.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
)) WITH CHECK ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_proposals.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - adds the binding reach that the agent_skills select policy already applies to this subquery, so no row becomes visible or writable that was not before; rollback restores the expression from 20261016100500_agent_skill_binding and earlier
ALTER POLICY "agent_skill_proposal_delete" ON "agent_skill_proposals" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_proposals.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - adds the binding reach that the agent_skills select policy already applies to this subquery, so no row becomes visible or writable that was not before; rollback restores the expression from 20261016100500_agent_skill_binding and earlier
ALTER POLICY "agent_skill_comment_select" ON "agent_skill_comments" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_comments.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - adds the binding reach that the agent_skills select policy already applies to this subquery, so no row becomes visible or writable that was not before; rollback restores the expression from 20261016100500_agent_skill_binding and earlier
ALTER POLICY "agent_skill_comment_insert" ON "agent_skill_comments" WITH CHECK ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_comments.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - adds the binding reach that the agent_skills select policy already applies to this subquery, so no row becomes visible or writable that was not before; rollback restores the expression from 20261016100500_agent_skill_binding and earlier
ALTER POLICY "agent_skill_comment_update" ON "agent_skill_comments" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_comments.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
)) WITH CHECK ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_comments.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - adds the binding reach that the agent_skills select policy already applies to this subquery, so no row becomes visible or writable that was not before; rollback restores the expression from 20261016100500_agent_skill_binding and earlier
ALTER POLICY "agent_skill_comment_delete" ON "agent_skill_comments" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_comments.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
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
));--> statement-breakpoint
