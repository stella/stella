SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A skill's scope decides who may read and write it, so the database refuses a
-- scope, origin, or resource kind the application does not define. The value
-- lists are AGENT_SKILL_SCOPES, AGENT_SKILL_ORIGINS, and SKILL_RESOURCE_KINDS
-- (@stll/skills/resource-kinds); every writer has only ever stored those values.

ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_scope_check"
  CHECK ("scope" IN ('team', 'private')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_origin_check"
  CHECK ("origin" IN ('authored', 'bundled', 'upload', 'url')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "agent_skill_resources"
  ADD CONSTRAINT "agent_skill_resources_kind_check"
  CHECK ("kind" IN ('asset', 'knowledge', 'prompt', 'reference', 'script', 'template')) NOT VALID;
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- added NOT VALID above; the validating scan reads the skills table, bounded by the per-organization and per-user skill limits
ALTER TABLE "agent_skills" VALIDATE CONSTRAINT "agent_skills_scope_check";
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- added NOT VALID above; the same bounded scan of the skills table
ALTER TABLE "agent_skills" VALIDATE CONSTRAINT "agent_skills_origin_check";
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- added NOT VALID above; the validating scan reads skill resources, bounded by the per-skill resource limit
ALTER TABLE "agent_skill_resources" VALIDATE CONSTRAINT "agent_skill_resources_kind_check";
