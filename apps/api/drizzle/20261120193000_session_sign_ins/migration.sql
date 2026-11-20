SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

CREATE TABLE "session_sign_ins" (
  "session_id" text PRIMARY KEY NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
  "location_kind" text NOT NULL,
  "country_code" text,
  "region" text,
  "city" text,
  "latitude" numeric(3, 1),
  "longitude" numeric(4, 1),
  "review" text DEFAULT 'not_required' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "session_sign_ins_review_check" CHECK ("session_sign_ins"."review" IN ('not_required', 'pending', 'confirmed')),
  CONSTRAINT "session_sign_ins_location_check" CHECK (("session_sign_ins"."location_kind" = 'unknown' AND "session_sign_ins"."country_code" IS NULL AND "session_sign_ins"."region" IS NULL AND "session_sign_ins"."city" IS NULL AND "session_sign_ins"."latitude" IS NULL AND "session_sign_ins"."longitude" IS NULL) OR ("session_sign_ins"."location_kind" = 'known' AND "session_sign_ins"."country_code" ~ '^[A-Z]{2}$' AND ("session_sign_ins"."latitude" IS NULL) = ("session_sign_ins"."longitude" IS NULL)))
);--> statement-breakpoint
ALTER TABLE "session_sign_ins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "session_sign_ins" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "session_sign_ins" FROM stella;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Replace the check atomically with its expanded set; existing values remain valid. Failure before commit restores the original check; retry after commit recreates the same expanded check.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "account_audit_logs" DROP CONSTRAINT IF EXISTS "account_audit_logs_event_type_check";--> statement-breakpoint
ALTER TABLE "account_audit_logs" ADD CONSTRAINT "account_audit_logs_event_type_check"
  CHECK ("event_type" IN ('account.data_export.requested', 'account.data_export.ready', 'account.data_export.downloaded', 'account.data_export.expired', 'account.sign_in_method.disconnected', 'account.oauth_connection.disconnected', 'account.sign_in.review_requested', 'account.sign_in.confirmed', 'account.sign_in.confirmation_undone', 'organization.created', 'organization.evaluation.started')) NOT VALID;
