SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Nullable with no default: adding this column does not rewrite existing rows.
ALTER TABLE "time_entries" ADD COLUMN "narrative_language" varchar(64);--> statement-breakpoint

CREATE TABLE "saved_time_narratives" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "name" varchar(128) NOT NULL,
  "narrative" text NOT NULL,
  "narrative_language" varchar(64),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "saved_time_narratives_name_check" CHECK (length("name") between 1 and 128),
  CONSTRAINT "saved_time_narratives_narrative_check" CHECK (length("narrative") between 1 and 10000)
);--> statement-breakpoint
CREATE INDEX "saved_time_narratives_owner_name_id_idx" ON "saved_time_narratives" ("organization_id", "user_id", "name", "id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "saved_time_narratives" TO stella;--> statement-breakpoint
ALTER TABLE "saved_time_narratives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saved_time_narratives" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Each policy pins both the signed-in user and active organization. UPDATE
-- checks the resulting row too, so ownership cannot be reassigned.
CREATE POLICY "user_select" ON "saved_time_narratives" AS PERMISSIVE FOR SELECT TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "saved_time_narratives" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "saved_time_narratives" AS PERMISSIVE FOR UPDATE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "saved_time_narratives" AS PERMISSIVE FOR DELETE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));
