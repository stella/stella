SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Org-level SSO provisioning mode and optional seat cap on organization_sso_policy.
ALTER TABLE "organization_sso_policy"
  ADD COLUMN "provisioning_mode" text DEFAULT 'invite_only' NOT NULL,
  ADD COLUMN "seat_limit" integer;--> statement-breakpoint
ALTER TABLE "organization_sso_policy"
  ADD CONSTRAINT "organization_sso_policy_provisioning_mode_check"
  CHECK ("provisioning_mode" IN ('invite_only', 'admin_approval', 'jit_active')) NOT VALID;--> statement-breakpoint
ALTER TABLE "organization_sso_policy"
  ADD CONSTRAINT "organization_sso_policy_seat_limit_check"
  CHECK ("seat_limit" IS NULL OR "seat_limit" >= 1) NOT VALID;--> statement-breakpoint

-- Pending SSO membership requests awaiting admin approval or an available seat.
-- Kept separate from `member` so pending users hold no workspace or RLS access
-- until an administrator explicitly approves them.
CREATE TABLE "organization_sso_pending_member" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "name" text,
  "sso_provider_id" text,
  "reason" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "reviewed_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_sso_pending_member_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "org_sso_pending_member_provider_fk" FOREIGN KEY ("sso_provider_id") REFERENCES "sso_provider"("id") ON DELETE SET NULL,
  CONSTRAINT "organization_sso_pending_member_reason_check"
    CHECK ("reason" IN ('admin_approval', 'seat_limit_reached')),
  CONSTRAINT "organization_sso_pending_member_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "organization_sso_pending_member_org_user_uidx"
  ON "organization_sso_pending_member" ("organization_id", "user_id");--> statement-breakpoint
CREATE INDEX "organization_sso_pending_member_org_status_idx"
  ON "organization_sso_pending_member" ("organization_id", "status");--> statement-breakpoint
CREATE INDEX "organization_sso_pending_member_user_id_idx"
  ON "organization_sso_pending_member" ("user_id");--> statement-breakpoint

ALTER TABLE "organization_sso_pending_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_sso_pending_member" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_sso_pending_member_owner_access"
  ON "organization_sso_pending_member" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_sso_pending_member'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_sso_pending_member'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "organization_sso_pending_member"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "organization_sso_pending_member" FROM stella;
