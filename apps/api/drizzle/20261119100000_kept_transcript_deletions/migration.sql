SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "kept_transcript_deletions" (
  "transcription_id" text PRIMARY KEY NOT NULL,
  "environment" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error_code" varchar(64),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "kept_transcript_deletions_environment_domain" CHECK (environment IN ('default', 'us', 'eu')),
  CONSTRAINT "kept_transcript_deletions_transcription_id_shape" CHECK (transcription_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT "kept_transcript_deletions_attempts_nonnegative" CHECK (attempts >= 0)
);--> statement-breakpoint
CREATE INDEX "kept_transcript_deletions_due_idx" ON "kept_transcript_deletions" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "kept_transcript_deletions_created_idx" ON "kept_transcript_deletions" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "kept_transcript_deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kept_transcript_deletions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "kept_transcript_deletions_owner_access" ON "kept_transcript_deletions" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.kept_transcript_deletions'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.kept_transcript_deletions'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "kept_transcript_deletions" FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "kept_transcript_deletions" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "kept_transcript_deletions" FROM stella;
