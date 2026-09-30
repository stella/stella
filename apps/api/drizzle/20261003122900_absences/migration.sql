-- requires: 20261003122800_time_entry_activity_groups
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
CREATE TABLE "absences" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" text REFERENCES "user"("id") ON DELETE set null,
  "kind" text NOT NULL,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "timezone_id" text NOT NULL,
  "coverage" text NOT NULL,
  "half_day_segment" text,
  "status" text DEFAULT 'requested' NOT NULL,
  "approver_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "decided_at" timestamptz,
  "decision_comment" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "absences_kind_check" CHECK ("absences"."kind" IN ('vacation', 'sick', 'other')),
  CONSTRAINT "absences_coverage_check" CHECK ("absences"."coverage" IN ('full', 'half')),
  CONSTRAINT "absences_half_day_segment_check" CHECK ("absences"."half_day_segment" IS NULL OR "absences"."half_day_segment" IN ('morning', 'afternoon')),
  CONSTRAINT "absences_status_check" CHECK ("absences"."status" IN ('requested', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT "absences_positive_range_check" CHECK ("absences"."end_date" > "absences"."start_date"),
  CONSTRAINT "absences_half_day_shape_check" CHECK (("absences"."coverage" = 'full' AND "absences"."half_day_segment" IS NULL) OR ("absences"."coverage" = 'half' AND "absences"."half_day_segment" IS NOT NULL AND "absences"."end_date" = "absences"."start_date" + 1)),
  CONSTRAINT "absences_decision_shape_check" CHECK (("absences"."status" = 'requested' AND "absences"."approver_user_id" IS NULL AND "absences"."decided_at" IS NULL AND "absences"."decision_comment" IS NULL) OR ("absences"."status" <> 'requested' AND "absences"."decided_at" IS NOT NULL)),
  CONSTRAINT "absences_decision_comment_check" CHECK ("absences"."decision_comment" IS NULL OR (char_length(btrim("absences"."decision_comment")) BETWEEN 1 AND 2000 AND char_length("absences"."decision_comment") <= 2000)),
  CONSTRAINT "absences_version_check" CHECK ("absences"."version" > 0)
);--> statement-breakpoint
CREATE INDEX "absences_org_user_start_id_idx" ON "absences" ("organization_id", "user_id", "start_date", "id");--> statement-breakpoint
CREATE INDEX "absences_org_status_start_id_idx" ON "absences" ("organization_id", "status", "start_date", "id");--> statement-breakpoint
CREATE INDEX "absences_user_id_idx" ON "absences" ("user_id");--> statement-breakpoint
CREATE INDEX "absences_approver_user_id_idx" ON "absences" ("approver_user_id");--> statement-breakpoint
ALTER TABLE "absences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "absences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "absences" TO stella;--> statement-breakpoint
CREATE POLICY "absences_owner_or_manager_select" ON "absences" AS PERMISSIVE FOR SELECT TO stella USING ((organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
  SELECT 1 FROM member m
  WHERE m.organization_id = absences.organization_id
    AND m.user_id = (SELECT current_setting('app.user_id', true))
    AND (absences.user_id = (SELECT current_setting('app.user_id', true))
      OR m.role IN ('owner', 'admin'))
)));--> statement-breakpoint
CREATE POLICY "absences_owner_insert" ON "absences" AS PERMISSIVE FOR INSERT TO stella WITH CHECK (((organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
  SELECT 1 FROM member m
  WHERE m.organization_id = absences.organization_id
    AND m.user_id = (SELECT current_setting('app.user_id', true))
    AND (absences.user_id = (SELECT current_setting('app.user_id', true))
      OR m.role IN ('owner', 'admin'))
)) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))));--> statement-breakpoint
CREATE POLICY "absences_owner_or_manager_update" ON "absences" AS PERMISSIVE FOR UPDATE TO stella USING ((organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
  SELECT 1 FROM member m
  WHERE m.organization_id = absences.organization_id
    AND m.user_id = (SELECT current_setting('app.user_id', true))
    AND (absences.user_id = (SELECT current_setting('app.user_id', true))
      OR m.role IN ('owner', 'admin'))
))) WITH CHECK ((organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND EXISTS (
  SELECT 1 FROM member m
  WHERE m.organization_id = absences.organization_id
    AND m.user_id = (SELECT current_setting('app.user_id', true))
    AND (absences.user_id = (SELECT current_setting('app.user_id', true))
      OR m.role IN ('owner', 'admin'))
)));--> statement-breakpoint
