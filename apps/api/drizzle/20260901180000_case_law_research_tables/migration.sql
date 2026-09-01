SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "case_law_research_tables" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "owner_user_id" text NOT NULL,
  "name" varchar(256) NOT NULL,
  "saved_query" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_research_tables_id_org_unq" UNIQUE ("id", "organization_id"),
  CONSTRAINT "case_law_research_tables_saved_query_version_check"
    CHECK ((
      jsonb_typeof("saved_query") = 'object'
      AND "saved_query"->'version' = '1'::jsonb
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "case_law_research_tables" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_law_research_tables" ADD CONSTRAINT "case_law_research_tables_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "case_law_research_tables" ADD CONSTRAINT "case_law_research_tables_owner_user_id_user_id_fk"
  FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "case_law_research_tables_org_updated_id_idx"
  ON "case_law_research_tables" USING btree ("organization_id", "updated_at", "id");
--> statement-breakpoint
CREATE POLICY "organization_select" ON "case_law_research_tables" AS PERMISSIVE FOR SELECT TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_insert" ON "case_law_research_tables" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_update" ON "case_law_research_tables" AS PERMISSIVE FOR UPDATE TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_delete" ON "case_law_research_tables" AS PERMISSIVE FOR DELETE TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_research_tables" TO stella;
--> statement-breakpoint
CREATE TABLE "case_law_research_table_decisions" (
  "table_id" uuid NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "decision_id" uuid NOT NULL,
  "disposition" text NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "added_by" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_research_table_decisions_pk" PRIMARY KEY ("table_id", "decision_id"),
  CONSTRAINT "case_law_research_table_decisions_disposition_check"
    CHECK ("disposition" IN ('pinned', 'excluded'))
);
--> statement-breakpoint
ALTER TABLE "case_law_research_table_decisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_law_research_table_decisions" ADD CONSTRAINT "clrtd_table_org_fk"
  FOREIGN KEY ("table_id", "organization_id") REFERENCES "case_law_research_tables"("id", "organization_id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "case_law_research_table_decisions" ADD CONSTRAINT "clrtd_decision_fk"
  FOREIGN KEY ("decision_id") REFERENCES "case_law_decisions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "case_law_research_table_decisions" ADD CONSTRAINT "clrtd_added_by_fk"
  FOREIGN KEY ("added_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "clrtd_table_disposition_position_idx"
  ON "case_law_research_table_decisions" USING btree ("table_id", "disposition", "position");
--> statement-breakpoint
CREATE POLICY "organization_select" ON "case_law_research_table_decisions" AS PERMISSIVE FOR SELECT TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_insert" ON "case_law_research_table_decisions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_update" ON "case_law_research_table_decisions" AS PERMISSIVE FOR UPDATE TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_delete" ON "case_law_research_table_decisions" AS PERMISSIVE FOR DELETE TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_research_table_decisions" TO stella;
