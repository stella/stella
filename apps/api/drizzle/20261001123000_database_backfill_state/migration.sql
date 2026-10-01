SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "database_backfill_states" (
  "name" text PRIMARY KEY NOT NULL,
  "cursor" text,
  "batch" jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "database_backfill_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "database_backfill_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The owner resumes maintenance under forced RLS; application roles cannot
-- read or mutate checkpoints even if table privileges are later granted.
CREATE POLICY "database_backfill_state_owner_access" ON "database_backfill_states"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.database_backfill_states'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.database_backfill_states'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "database_backfill_states" FROM stella;
