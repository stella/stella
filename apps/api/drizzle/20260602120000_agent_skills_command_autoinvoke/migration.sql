-- Unify "prompts" and "skills" into a single concept (`agent_skills`).
-- Adds two optional capability columns:
--   * `command`           — slash-command handle; presence surfaces
--                           the skill in the chat slash menu
--   * `auto_invoke_hint`  — text shown to the model so it can decide
--                           whether to auto-invoke the skill
-- Both are nullable, neither is mutually exclusive with the existing
-- resource bundle. A "prompt-only" skill has command + body + null
-- auto_invoke_hint, no resources. A classic "skill" has body +
-- resources + auto_invoke_hint, no command. Hybrid skills are
-- allowed.
--
-- A one-time data migration copies every `prompt_shortcuts` row into
-- `agent_skills`. The legacy table stays in place for at least one
-- release so older clients keep working; a follow-up cleanup PR
-- drops it once the new surface has rolled out.

ALTER TABLE "agent_skills" ADD COLUMN "command" varchar(50);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "auto_invoke_hint" text;
--> statement-breakpoint

-- Uniqueness: a team command is unique per organization. A private
-- command is unique per (organization, user). Null commands never
-- collide (partial WHERE clause).
CREATE UNIQUE INDEX "agent_skills_org_team_command_uidx"
  ON "agent_skills" ("organization_id", "command")
  WHERE scope = 'team' AND command IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skills_user_private_command_uidx"
  ON "agent_skills" ("organization_id", "user_id", "command")
  WHERE scope = 'private' AND command IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "agent_skills_org_command_idx"
  ON "agent_skills" ("organization_id", "command")
  WHERE command IS NOT NULL;
--> statement-breakpoint

-- One-time data migration: import every prompt_shortcuts row as an
-- authored skill. `slug` must be lowercase letters/digits/hyphens
-- only and fit in 64 chars (mirrors the agent_skills slug constraint).
-- We derive it from the legacy command which already satisfies the
-- skill slug regex, then append a short hash suffix to avoid the
-- (org, scope, slug) uniqueness collision when the same command was
-- saved under both team and private scope.
--
-- ON CONFLICT DO NOTHING guards against re-running this migration
-- accidentally; the unique indexes above will reject duplicates.
INSERT INTO "agent_skills" (
  "id",
  "organization_id",
  "user_id",
  "scope",
  "origin",
  "slug",
  "name",
  "description",
  "version",
  "license",
  "compatibility",
  "metadata",
  "source_url",
  "content_hash",
  "body",
  "enabled",
  "command",
  "auto_invoke_hint",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  ps."organization_id",
  ps."user_id",
  ps."scope",
  'authored',
  -- slug: trim to 56 chars + short id suffix so total stays <= 64 and
  -- doesn't collide with other prompt slugs that share the same root.
  substring(
    regexp_replace(lower(ps."command"), '[^a-z0-9-]', '-', 'g'),
    1, 56
  )
    || '-'
    || substring(md5(ps."id"::text), 1, 7),
  ps."name",
  COALESCE(ps."description", ''),
  NULL,
  NULL,
  NULL,
  '{}'::jsonb,
  NULL,
  -- contentHash is required (NOT NULL). md5 is a built-in (no
  -- pgcrypto dependency) and the column is an integrity marker
  -- only — no uniqueness or cryptographic property is required for
  -- migrated rows.
  md5(ps."prompt"),
  ps."prompt",
  true,
  ps."command",
  NULL,
  ps."created_at",
  ps."updated_at"
FROM "prompt_shortcuts" ps
WHERE NOT EXISTS (
  SELECT 1 FROM "agent_skills" ag
  WHERE ag."organization_id" = ps."organization_id"
    AND ag."user_id"         = ps."user_id"
    AND ag."command"         = ps."command"
    AND ag."scope"           = ps."scope"
)
ON CONFLICT DO NOTHING;
