-- requires: 20261004001000_matter_membership_organization_membership
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Commit the prerequisite and its migration receipt before validation.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The triggers hold new writes; this proves existing rows already satisfy the
-- reference, as VALIDATE CONSTRAINT does for a foreign key added NOT VALID.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.workspace_members wm
    JOIN public.workspaces w ON w.id = wm.workspace_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.member m
      WHERE m.organization_id = w.organization_id
        AND m.user_id = wm.user_id
    )
  ) THEN
    RAISE EXCEPTION 'matter membership requires organization membership'
      USING ERRCODE = 'foreign_key_violation',
            CONSTRAINT = 'workspace_members_organization_member';
  END IF;
END;
$$;
