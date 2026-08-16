SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Which members occupy the organisation's purchased seats: assigned
-- members draw the per-user included budgets, everyone else keeps the
-- shared-pool path. Manager-managed; bounded by the entitlement's seat
-- count at write time.
CREATE TABLE IF NOT EXISTS "usage_seat_assignments" (
  "id" uuid PRIMARY KEY,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "assigned_by_user_id" text REFERENCES "user" ("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "usage_seat_assignments_org_user_uidx"
  ON "usage_seat_assignments" ("organization_id", "user_id");--> statement-breakpoint

ALTER TABLE "usage_seat_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "usage_seat_assignments_select" ON "usage_seat_assignments" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

CREATE POLICY "usage_seat_assignments_insert" ON "usage_seat_assignments" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

CREATE POLICY "usage_seat_assignments_delete" ON "usage_seat_assignments" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

CREATE POLICY "usage_seat_assignments_no_update" ON "usage_seat_assignments" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "usage_seat_assignments" TO stella;
