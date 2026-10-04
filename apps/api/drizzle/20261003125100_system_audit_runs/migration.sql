SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "system_audit_runs" (
  "id" uuid PRIMARY KEY,
  "actor" text NOT NULL,
  "subject" text NOT NULL,
  "counts" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "system_audit_runs_actor_check" CHECK ("actor" ~ '^system:[a-z][a-z0-9-]*$'),
  CONSTRAINT "system_audit_runs_subject_check" CHECK (char_length("subject") BETWEEN 1 AND 128),
  CONSTRAINT "system_audit_runs_counts_check" CHECK (jsonb_typeof("counts") = 'object')
);--> statement-breakpoint
CREATE INDEX "system_audit_runs_created_at_idx" ON "system_audit_runs" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "system_audit_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "system_audit_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "system_audit_runs_owner_access" ON "system_audit_runs" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.system_audit_runs'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.system_audit_runs'::regclass));--> statement-breakpoint
CREATE POLICY "system_audit_runs_stella_insert" ON "system_audit_runs" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "system_audit_runs_no_update" ON "system_audit_runs" AS RESTRICTIVE FOR UPDATE TO public USING (false);--> statement-breakpoint
CREATE POLICY "system_audit_runs_no_stella_delete" ON "system_audit_runs" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "system_audit_runs" FROM stella;--> statement-breakpoint
GRANT INSERT ON TABLE "system_audit_runs" TO stella;
