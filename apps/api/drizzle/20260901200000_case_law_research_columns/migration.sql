SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "case_law_research_columns" (
  "id" uuid PRIMARY KEY NOT NULL,
  "table_id" uuid NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "position" integer NOT NULL,
  "question" varchar(512) NOT NULL,
  "answer_type" text NOT NULL,
  "tool" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_research_columns_id_org_unq" UNIQUE ("id", "organization_id"),
  CONSTRAINT "case_law_research_columns_answer_type_check"
    CHECK ("answer_type" IN ('yes_no', 'text'))
);
--> statement-breakpoint
ALTER TABLE "case_law_research_columns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_law_research_columns" ADD CONSTRAINT "clrc_table_org_fk"
  FOREIGN KEY ("table_id", "organization_id") REFERENCES "case_law_research_tables"("id", "organization_id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "clrc_table_position_idx"
  ON "case_law_research_columns" USING btree ("table_id", "position");
--> statement-breakpoint
CREATE POLICY "organization_select" ON "case_law_research_columns" AS PERMISSIVE FOR SELECT TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_insert" ON "case_law_research_columns" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_update" ON "case_law_research_columns" AS PERMISSIVE FOR UPDATE TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_delete" ON "case_law_research_columns" AS PERMISSIVE FOR DELETE TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_research_columns" TO stella;
--> statement-breakpoint
CREATE TABLE "case_law_research_answers" (
  "column_id" uuid NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "decision_id" uuid NOT NULL,
  "state" text NOT NULL,
  "answer" jsonb,
  "confidence" double precision,
  "run" jsonb,
  "failure_reason" varchar(64),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_research_answers_pk" PRIMARY KEY ("column_id", "decision_id"),
  CONSTRAINT "case_law_research_answers_state_check"
    CHECK ("state" IN ('pending', 'answered', 'not_allowed', 'failed')),
  CONSTRAINT "case_law_research_answers_confidence_check"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  CONSTRAINT "case_law_research_answers_answer_state_check"
    CHECK (("state" = 'answered') = ("answer" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "case_law_research_answers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_law_research_answers" ADD CONSTRAINT "clra_column_org_fk"
  FOREIGN KEY ("column_id", "organization_id") REFERENCES "case_law_research_columns"("id", "organization_id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "clra_column_state_idx"
  ON "case_law_research_answers" USING btree ("column_id", "state");
--> statement-breakpoint
CREATE POLICY "organization_select" ON "case_law_research_answers" AS PERMISSIVE FOR SELECT TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_insert" ON "case_law_research_answers" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_update" ON "case_law_research_answers" AS PERMISSIVE FOR UPDATE TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
CREATE POLICY "organization_delete" ON "case_law_research_answers" AS PERMISSIVE FOR DELETE TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_research_answers" TO stella;
