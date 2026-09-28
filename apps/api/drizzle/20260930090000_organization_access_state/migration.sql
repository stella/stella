SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- One access state per organization. Each state admits exactly one shape of
-- evaluation columns; see ORGANIZATION_ACCESS_STATE in the schema.
CREATE TABLE "organization_access_states" (
  "organization_id" varchar(128) PRIMARY KEY NOT NULL,
  "state" text NOT NULL,
  "evaluation_started_at" timestamp with time zone,
  "evaluation_ends_at" timestamp with time zone,
  "evaluation_ended_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_access_states_shape" CHECK (((state = 'self_managed_keys' AND evaluation_started_at IS NULL AND evaluation_ends_at IS NULL AND evaluation_ended_at IS NULL) OR (state = 'evaluation_period' AND evaluation_ends_at > evaluation_started_at AND evaluation_ended_at IS NULL) OR (state = 'evaluation_ended' AND evaluation_ends_at > evaluation_started_at AND evaluation_ended_at IS NOT NULL)) IS TRUE),
  CONSTRAINT "organization_access_states_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade
);--> statement-breakpoint

-- Snapshot: every organization that exists when this runs keeps its own-key
-- path. Organizations created later record their state at creation.
-- stella-migration-safety: reviewed insert-select - one row per organization into the table created above in this transaction; reads organization under ACCESS SHARE, and a rollback drops the table with the snapshot
INSERT INTO "organization_access_states" ("organization_id", "state")
SELECT "id", 'self_managed_keys' FROM "organization";--> statement-breakpoint

ALTER TABLE "organization_access_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_access_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "organization_access_states" TO "stella";--> statement-breakpoint
CREATE POLICY "organization_access_states_owner_select" ON "organization_access_states" AS PERMISSIVE FOR SELECT TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_access_states'::regclass));--> statement-breakpoint
CREATE POLICY "organization_access_states_owner_insert" ON "organization_access_states" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_access_states'::regclass));--> statement-breakpoint
CREATE POLICY "organization_access_states_owner_update" ON "organization_access_states" AS PERMISSIVE FOR UPDATE TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_access_states'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_access_states'::regclass));--> statement-breakpoint
CREATE POLICY "organization_access_states_select" ON "organization_access_states" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_access_states_no_insert" ON "organization_access_states" AS RESTRICTIVE FOR INSERT TO "stella" WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "organization_access_states_no_update" ON "organization_access_states" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);--> statement-breakpoint
CREATE POLICY "organization_access_states_no_delete" ON "organization_access_states" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);
