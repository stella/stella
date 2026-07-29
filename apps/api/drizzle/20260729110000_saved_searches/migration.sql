SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "saved_searches" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "name" varchar(256) NOT NULL,
  "criteria" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "saved_searches_criteria_version_check"
    CHECK ((
      jsonb_typeof("criteria") = 'object'
      AND "criteria"->'version' = '1'::jsonb
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "saved_searches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_organization_id_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "saved_searches_org_user_updated_id_idx"
  ON "saved_searches" USING btree ("organization_id", "user_id", "updated_at", "id");
--> statement-breakpoint
CREATE POLICY "saved_search_select" ON "saved_searches" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND user_id = (SELECT current_setting('app.user_id', true))
));
--> statement-breakpoint
CREATE POLICY "saved_search_insert" ON "saved_searches" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND user_id = (SELECT current_setting('app.user_id', true))
));
--> statement-breakpoint
CREATE POLICY "saved_search_update" ON "saved_searches" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND user_id = (SELECT current_setting('app.user_id', true))
)) WITH CHECK ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND user_id = (SELECT current_setting('app.user_id', true))
));
--> statement-breakpoint
CREATE POLICY "saved_search_delete" ON "saved_searches" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND user_id = (SELECT current_setting('app.user_id', true))
));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "saved_searches" TO stella;
