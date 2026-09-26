SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Writes to a skill and its resources follow the rule the handlers apply:
-- organization owners and admins for team skills, the author for private
-- ones. Reads, proposals, and comments keep their existing policies.

-- stella-migration-safety: reviewed alter-policy - a team row now also needs an owner or admin membership in the session organization, which the handlers already required, so this only narrows who may insert; rollback restores the previous WITH CHECK expression
ALTER POLICY "agent_skill_insert" ON "agent_skills"
  WITH CHECK ((
  (
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (
    (scope = 'team' AND EXISTS (
  SELECT 1
  FROM member m
  WHERE m.organization_id = (SELECT current_setting(
      'app.organization_id', true
    ))
    AND m.user_id = (SELECT current_setting(
      'app.user_id', true
    ))
    AND m.role IN ('owner', 'admin')
))
    OR (scope = 'private' AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  )))
  )
) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - team rows now need an owner or admin membership and private rows their author, where any organization member could update a team row before; only narrows, and proposal edits lock the proposal row rather than the skill; rollback restores the previous expressions
ALTER POLICY "agent_skill_update" ON "agent_skills"
  USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (
    (scope = 'team' AND EXISTS (
  SELECT 1
  FROM member m
  WHERE m.organization_id = (SELECT current_setting(
      'app.organization_id', true
    ))
    AND m.user_id = (SELECT current_setting(
      'app.user_id', true
    ))
    AND m.role IN ('owner', 'admin')
))
    OR (scope = 'private' AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  )))
  )
))
  WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (
    (scope = 'team' AND EXISTS (
  SELECT 1
  FROM member m
  WHERE m.organization_id = (SELECT current_setting(
      'app.organization_id', true
    ))
    AND m.user_id = (SELECT current_setting(
      'app.user_id', true
    ))
    AND m.role IN ('owner', 'admin')
))
    OR (scope = 'private' AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  )))
  )
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - the same narrowing as agent_skill_update, for deletes; rollback restores the previous USING expression
ALTER POLICY "agent_skill_delete" ON "agent_skills"
  USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (
    (scope = 'team' AND EXISTS (
  SELECT 1
  FROM member m
  WHERE m.organization_id = (SELECT current_setting(
      'app.organization_id', true
    ))
    AND m.user_id = (SELECT current_setting(
      'app.user_id', true
    ))
    AND m.role IN ('owner', 'admin')
))
    OR (scope = 'private' AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  )))
  )
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - resources follow their skill, owners and admins for team skills and the author for private ones; only narrows; rollback restores the previous WITH CHECK expression
ALTER POLICY "agent_skill_resource_insert" ON "agent_skill_resources"
  WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_resources.organization_id
      AND (
        (s.scope = 'team' AND EXISTS (
  SELECT 1
  FROM member m
  WHERE m.organization_id = (SELECT current_setting(
      'app.organization_id', true
    ))
    AND m.user_id = (SELECT current_setting(
      'app.user_id', true
    ))
    AND m.role IN ('owner', 'admin')
))
        OR (s.scope = 'private' AND s.user_id = (SELECT current_setting(
          'app.user_id', true
        )))
      )
  )
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - the same narrowing as agent_skill_resource_insert, for updates; rollback restores the previous expressions
ALTER POLICY "agent_skill_resource_update" ON "agent_skill_resources"
  USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_resources.organization_id
      AND (
        (s.scope = 'team' AND EXISTS (
  SELECT 1
  FROM member m
  WHERE m.organization_id = (SELECT current_setting(
      'app.organization_id', true
    ))
    AND m.user_id = (SELECT current_setting(
      'app.user_id', true
    ))
    AND m.role IN ('owner', 'admin')
))
        OR (s.scope = 'private' AND s.user_id = (SELECT current_setting(
          'app.user_id', true
        )))
      )
  )
))
  WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_resources.organization_id
      AND (
        (s.scope = 'team' AND EXISTS (
  SELECT 1
  FROM member m
  WHERE m.organization_id = (SELECT current_setting(
      'app.organization_id', true
    ))
    AND m.user_id = (SELECT current_setting(
      'app.user_id', true
    ))
    AND m.role IN ('owner', 'admin')
))
        OR (s.scope = 'private' AND s.user_id = (SELECT current_setting(
          'app.user_id', true
        )))
      )
  )
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - the same narrowing as agent_skill_resource_insert, for deletes; rollback restores the previous USING expression
ALTER POLICY "agent_skill_resource_delete" ON "agent_skill_resources"
  USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_resources.organization_id
      AND (
        (s.scope = 'team' AND EXISTS (
  SELECT 1
  FROM member m
  WHERE m.organization_id = (SELECT current_setting(
      'app.organization_id', true
    ))
    AND m.user_id = (SELECT current_setting(
      'app.user_id', true
    ))
    AND m.role IN ('owner', 'admin')
))
        OR (s.scope = 'private' AND s.user_id = (SELECT current_setting(
          'app.user_id', true
        )))
      )
  )
));
