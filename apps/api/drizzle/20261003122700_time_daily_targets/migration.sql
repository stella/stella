-- requires: 20260817120000_usage_member_assignment
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "time_daily_targets" (
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "minutes" integer,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "time_daily_targets_organization_id_user_id_pk" PRIMARY KEY ("organization_id", "user_id"),
  CONSTRAINT "time_daily_targets_member_fk" FOREIGN KEY ("organization_id", "user_id") REFERENCES "member"("organization_id", "user_id") ON DELETE CASCADE,
  CONSTRAINT "time_daily_targets_minutes_check" CHECK ("minutes" IS NULL OR ("minutes" > 0 AND "minutes" <= 1440))
);--> statement-breakpoint
ALTER TABLE "time_daily_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "time_daily_targets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "time_daily_targets" TO stella;--> statement-breakpoint
CREATE POLICY "member_target_access" ON "time_daily_targets" AS PERMISSIVE FOR ALL TO stella
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND (
      user_id = (SELECT current_setting('app.user_id', true))
      OR EXISTS (
        SELECT 1 FROM "member"
        WHERE "member"."organization_id" = (SELECT current_setting('app.organization_id', true))
          AND "member"."user_id" = (SELECT current_setting('app.user_id', true))
          AND "member"."role" IN ('owner', 'admin')
      )
    )
  )
  WITH CHECK (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND (
      user_id = (SELECT current_setting('app.user_id', true))
      OR EXISTS (
        SELECT 1 FROM "member"
        WHERE "member"."organization_id" = (SELECT current_setting('app.organization_id', true))
          AND "member"."user_id" = (SELECT current_setting('app.user_id', true))
          AND "member"."role" IN ('owner', 'admin')
      )
    )
  );--> statement-breakpoint
