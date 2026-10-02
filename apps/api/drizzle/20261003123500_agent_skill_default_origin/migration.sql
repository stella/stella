-- requires: 20260925230200_agent_skill_domain_checks
-- requires: 20260925230400_agent_skill_default_backfill
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The starter skills seedDefaultSkills installs get their own origin, so they
-- are no longer indistinguishable from a member's own authored skill. The value
-- list is AGENT_SKILL_ORIGINS.

-- stella-migration-safety: reviewed drop-constraint - replaced in the same transaction by a check that admits every previously allowed origin plus 'default'
ALTER TABLE "agent_skills" DROP CONSTRAINT "agent_skills_origin_check";
--> statement-breakpoint

ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_origin_check"
  CHECK ("origin" IN ('authored', 'bundled', 'default', 'upload', 'url')) NOT VALID;
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- added NOT VALID above; the validating scan reads the skills table, bounded by the per-organization and per-user skill limits
ALTER TABLE "agent_skills" VALIDATE CONSTRAINT "agent_skills_origin_check";
--> statement-breakpoint

-- Rows seeded before this migration carry 'authored'; the private scope and
-- slugs are exactly what seedDefaultSkills and the default-skill backfill
-- write. At most four rows per membership; a rerun matches nothing.
UPDATE "agent_skills"
   SET "origin" = 'default'
 WHERE "origin" = 'authored'
   AND "scope" = 'private'
   AND "slug" IN ('summarize-default', 'risks-default', 'compare-default', 'draft-default');
