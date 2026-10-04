-- requires: 20260925230200_agent_skill_domain_checks
-- requires: 20260925230400_agent_skill_default_backfill
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The starter skills seedDefaultSkills installs get their own origin, so they
-- are no longer indistinguishable from a member's own authored skill. The value
-- list is AGENT_SKILL_ORIGINS.

-- stella-migration-safety: reviewed drop-constraint - replaced in the same transaction by a check that admits every previously allowed origin plus 'default'
ALTER TABLE "agent_skills" DROP CONSTRAINT IF EXISTS "agent_skills_origin_check";
--> statement-breakpoint

ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_origin_check"
  CHECK ("origin" IN ('authored', 'bundled', 'default', 'upload', 'url')) NOT VALID;
--> statement-breakpoint

-- Commit the swap and release its ACCESS EXCLUSIVE lock before validating.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE, which readers and writers do not wait
-- on. A failure after this point replays the file: the swap above is guarded
-- by DROP ... IF EXISTS, and validating a validated constraint changes nothing.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- added NOT VALID above; the validating scan reads the skills table, bounded by the per-organization and per-user skill limits
ALTER TABLE "agent_skills" VALIDATE CONSTRAINT "agent_skills_origin_check";
--> statement-breakpoint

-- Rows seeded before this migration carry 'authored'. A member may since have
-- created a private skill under a starter slug (after deleting the starter),
-- so the slug alone is not provenance. A row moves only when its name and
-- command are the starter's and its first revision holds the starter body,
-- written by stella: either with no author (seeded on the owner connection,
-- by the default-skill backfill, or before revisions existed) or recorded by
-- the seed with an audit event marked seeded. The starter values are
-- DEFAULT_SKILLS in apps/api/src/lib/agent-skills/default-skills.ts. At most
-- four rows per membership; a rerun matches nothing.
UPDATE "agent_skills" s
   SET "origin" = 'default'
  FROM (
    VALUES
      ('summarize-default', 'summarize', 'Summarise a document', 'Summarise this document. Cover parties, key obligations, dates, financial terms, and any termination or liability provisions.'),
      ('risks-default', 'risks', 'Find risks', 'Review this document for legal risks, missing protections, and ambiguous clauses. Cite the specific clause for each finding.'),
      ('compare-default', 'compare', 'Compare versions', 'Compare two versions of this document and list every material change with its location.'),
      ('draft-default', 'draft', 'Draft a response', 'Draft a measured response to this letter. Keep the tone professional, address each point raised, and flag any open questions for me to confirm.')
  ) AS d (slug, command, name, body)
 WHERE s."origin" = 'authored'
   AND s."scope" = 'private'
   AND s."slug" = d.slug
   AND s."command" = d.command
   AND s."name" = d.name
   AND EXISTS (
     SELECT 1
       FROM "agent_skill_revisions" r
      WHERE r."skill_id" = s."id"
        AND r."revision_number" = 1
        AND r."body" = d.body
        AND (
          r."created_by" IS NULL
          OR EXISTS (
            SELECT 1
              FROM "audit_logs" a
             WHERE a."organization_id" = s."organization_id"
               AND a."resource_type" = 'agent_skill'
               AND a."resource_id" = s."id"::text
               AND a."action" = 'create'
               AND a."metadata" @> '{"seeded": true}'::jsonb
          )
        )
   );
