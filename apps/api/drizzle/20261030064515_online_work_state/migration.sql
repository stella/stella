SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

CREATE TABLE "online_work_state" (
  "name" text PRIMARY KEY NOT NULL,
  "state" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "online_work_state_state_check" CHECK ("state" IN ('building', 'finalized', 'failed'))
);--> statement-breakpoint
ALTER TABLE "online_work_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "online_work_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "online_work_state_owner_access" ON "online_work_state" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.online_work_state'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.online_work_state'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "online_work_state" FROM stella;
