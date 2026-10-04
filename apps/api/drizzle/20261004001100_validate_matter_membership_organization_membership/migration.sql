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
-- A matter membership whose user no longer belongs to the matter's
-- organization grants nothing; remove it with one audit row per membership,
-- in the shape matter membership removal records, so validation below holds.
-- stella-migration-safety: reviewed delete-data - deletes only matter memberships whose user has no organization membership in the matter's organization; the triggers committed above prevent new ones, so the set is closed and normally empty. Rollback: none needed; each removal is kept in audit_logs and access is granted again through the matter's member list.
-- stella-migration-safety: reviewed insert-select - writes one audit row per membership deleted by the same statement.
WITH removed_memberships AS (
  DELETE FROM "workspace_members" AS "wm"
  USING "workspaces" AS "w"
  WHERE "w"."id" = "wm"."workspace_id"
    AND NOT EXISTS (
      SELECT 1
      FROM "member" AS "m"
      WHERE "m"."organization_id" = "w"."organization_id"
        AND "m"."user_id" = "wm"."user_id"
    )
  RETURNING
    "wm"."id",
    "wm"."workspace_id",
    "wm"."user_id",
    "w"."organization_id"
)
INSERT INTO "audit_logs" (
  "id",
  "organization_id",
  "workspace_id",
  "user_id",
  "action",
  "resource_type",
  "resource_id",
  "metadata",
  "changes",
  "performer_type",
  "performer_id",
  "performer_name",
  "trigger_type",
  "trigger_source",
  "trigger_source_id",
  "activity_category"
)
SELECT
  md5('20261004001100_validate_matter_membership_organization_membership:' || "removed_memberships"."id"::text)::uuid,
  "removed_memberships"."organization_id",
  "removed_memberships"."workspace_id",
  "removed_memberships"."user_id",
  'delete',
  'workspace_member',
  "removed_memberships"."id",
  jsonb_build_object('cause', 'organization_membership_missing'),
  jsonb_build_object(
    'deleted', jsonb_build_object(
      'old', jsonb_build_object(
        'userId', "removed_memberships"."user_id",
        'workspaceId', "removed_memberships"."workspace_id"
      ),
      'new', NULL
    )
  ),
  'service',
  'database-migration',
  'Matter membership repair',
  'system',
  'database_migration',
  '20261004001100_validate_matter_membership_organization_membership',
  'team'
FROM "removed_memberships";
--> statement-breakpoint
-- The triggers hold new writes;this proves existing rows already satisfy the
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
