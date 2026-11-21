-- requires: 20261120070000_agent_skill_package_size_guard
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A skill file keeps its original, byte for byte, in object storage beside
-- its text: the uploaded PDF or DOCX, or an imported binary that has no text.
-- All four columns are set together or not at all, by the API's one writer.
ALTER TABLE "agent_skill_resources" ADD COLUMN IF NOT EXISTS "original_s3_key" text;--> statement-breakpoint
ALTER TABLE "agent_skill_resources" ADD COLUMN IF NOT EXISTS "original_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_skill_resources" ADD COLUMN IF NOT EXISTS "original_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "agent_skill_resources" ADD COLUMN IF NOT EXISTS "original_media_type" text;--> statement-breakpoint
-- The index agent_skill_resources_original_s3_key_idx is built
-- concurrently in the online phase.

-- Originals to erase, recorded by the triggers of the next migration in the
-- transaction that deletes a file or drops its original, whatever deleted
-- it; the scheduler task agentSkills.cleanOriginalObjects erases them.
CREATE TABLE IF NOT EXISTS "agent_skill_original_cleanup_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "s3_keys" text[] NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_skill_original_cleanup_attempts_nonnegative" CHECK (attempts >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_skill_original_cleanup_due_idx" ON "agent_skill_original_cleanup_requests" USING btree ("next_attempt_at");--> statement-breakpoint

-- Only the owner reaches the queue: its trigger function inserts, the
-- scheduler drains. Request roles are granted nothing.
ALTER TABLE "agent_skill_original_cleanup_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_skill_original_cleanup_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agent_skill_original_cleanup_owner_access" ON "agent_skill_original_cleanup_requests" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.agent_skill_original_cleanup_requests'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.agent_skill_original_cleanup_requests'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "agent_skill_original_cleanup_requests" FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "agent_skill_original_cleanup_requests" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "agent_skill_original_cleanup_requests" FROM stella;
