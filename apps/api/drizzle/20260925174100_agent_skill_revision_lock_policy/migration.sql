SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Proposals and comments lock the revision they anchor to (`FOR SHARE`) so a
-- concurrent save cannot coalesce into it. A row lock needs UPDATE privilege on
-- some column and passes through the update policy, so the app role gets both,
-- while the policy's WITH CHECK (false) still refuses every actual update.
GRANT UPDATE ("id") ON TABLE "agent_skill_revisions" TO stella;--> statement-breakpoint

CREATE POLICY "agent_skill_revision_lock" ON "agent_skill_revisions" AS PERMISSIVE FOR UPDATE TO "stella"
  USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_revisions.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting(
        'app.user_id', true
      )))
  )
))
  WITH CHECK (false);
