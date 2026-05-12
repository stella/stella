CREATE TABLE "agent_skills" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"origin" text NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(64) NOT NULL,
	"description" text NOT NULL,
	"version" varchar(64),
	"license" text,
	"compatibility" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"source_url" text,
	"content_hash" varchar(64) NOT NULL,
	"body" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skill_resources" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"skill_id" uuid NOT NULL,
	"path" varchar(512) NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_skill_resources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "agent_skill_resources" ADD CONSTRAINT "agent_skill_resources_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "agent_skill_resources" ADD CONSTRAINT "agent_skill_resources_skill_id_agent_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "agent_skills"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skills_org_team_slug_uidx" ON "agent_skills" ("organization_id","slug") WHERE scope = 'team';
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skills_user_private_slug_uidx" ON "agent_skills" ("organization_id","user_id","slug") WHERE scope = 'private';
--> statement-breakpoint
CREATE INDEX "agent_skills_org_scope_idx" ON "agent_skills" ("organization_id","scope");
--> statement-breakpoint
CREATE INDEX "agent_skills_org_enabled_idx" ON "agent_skills" ("organization_id","enabled");
--> statement-breakpoint
CREATE INDEX "agent_skills_user_idx" ON "agent_skills" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skill_resources_skill_path_uidx" ON "agent_skill_resources" ("skill_id","path");
--> statement-breakpoint
CREATE INDEX "agent_skill_resources_skill_idx" ON "agent_skill_resources" ("skill_id");
--> statement-breakpoint
CREATE INDEX "agent_skill_resources_org_skill_idx" ON "agent_skill_resources" ("organization_id","skill_id");
--> statement-breakpoint
CREATE POLICY "agent_skill_select" ON "agent_skills" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (scope = 'team' OR user_id =
  (SELECT current_setting(
    'app.user_id', true
  )))
));
--> statement-breakpoint
CREATE POLICY "agent_skill_insert" ON "agent_skills" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
--> statement-breakpoint
CREATE POLICY "agent_skill_update" ON "agent_skills" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (scope = 'team' OR user_id =
  (SELECT current_setting(
    'app.user_id', true
  )))
)) WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (scope = 'team' OR user_id =
  (SELECT current_setting(
    'app.user_id', true
  )))
));
--> statement-breakpoint
CREATE POLICY "agent_skill_delete" ON "agent_skills" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (scope = 'team' OR user_id =
  (SELECT current_setting(
    'app.user_id', true
  )))
));
--> statement-breakpoint
CREATE POLICY "agent_skill_resource_select" ON "agent_skill_resources" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting(
        'app.user_id', true
      )))
  )
));
--> statement-breakpoint
CREATE POLICY "agent_skill_resource_insert" ON "agent_skill_resources" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting(
        'app.user_id', true
      )))
  )
));
--> statement-breakpoint
CREATE POLICY "agent_skill_resource_update" ON "agent_skill_resources" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting(
        'app.user_id', true
      )))
  )
)) WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting(
        'app.user_id', true
      )))
  )
));
--> statement-breakpoint
CREATE POLICY "agent_skill_resource_delete" ON "agent_skill_resources" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting(
        'app.user_id', true
      )))
  )
));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "agent_skills", "agent_skill_resources" TO stella;
