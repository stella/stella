-- Saved structural-block recipes for templates: a named, org-wide
-- snapshot of pre-configured field metadata (optionally wrapped in a
-- {{#each}} loop) insertable into any template. Hand-rolled
-- (drizzle-kit generate requires TTY in this harness).

CREATE TABLE "template_recipes" (
  "id" uuid PRIMARY KEY,
  "organization_id" varchar(128) NOT NULL,
  "name" varchar(256) NOT NULL,
  "description" text,
  "definition" jsonb NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_recipes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "template_recipes_organization_id_idx"
  ON "template_recipes" ("organization_id");
--> statement-breakpoint
CREATE INDEX "template_recipes_organization_id_name_idx"
  ON "template_recipes" ("organization_id", "name");
--> statement-breakpoint
ALTER TABLE "template_recipes"
  ADD CONSTRAINT "template_recipes_organization_id_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "template_recipes"
  ADD CONSTRAINT "template_recipes_created_by_user_id_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE POLICY "organization_select" ON "template_recipes"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_insert" ON "template_recipes"
  AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_update" ON "template_recipes"
  AS PERMISSIVE FOR UPDATE TO "stella"
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_delete" ON "template_recipes"
  AS PERMISSIVE FOR DELETE TO "stella"
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
-- The role-bootstrap migration granted table permissions in a single
-- sweep; new RLS-enabled tables miss that, so grant explicitly here.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "template_recipes" TO stella;
