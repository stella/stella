SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
-- The coordinator applies this migration before recording its schema-phase receipt.
CREATE TABLE "scheduler_table_leases" (
  "table_name" text NOT NULL,
  "holder_kind" text NOT NULL CHECK ("holder_kind" IN ('job', 'migration')),
  "holder_id" text NOT NULL,
  "mode" text NOT NULL CHECK ("mode" IN ('shared', 'exclusive')),
  "requested_at" timestamptz DEFAULT clock_timestamp() NOT NULL,
  "granted_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "scheduler_table_leases_table_name_holder_kind_holder_id_pk" PRIMARY KEY ("table_name", "holder_kind", "holder_id"),
  CONSTRAINT "scheduler_table_lease_kind_mode" CHECK (
    ("holder_kind" = 'job' AND "mode" = 'shared' AND "granted_at" IS NOT NULL)
    OR ("holder_kind" = 'migration' AND "mode" = 'exclusive')
  )
);--> statement-breakpoint
CREATE INDEX "scheduler_table_leases_queue_idx"
  ON "scheduler_table_leases" ("table_name", "requested_at", "holder_id", "expires_at");--> statement-breakpoint
CREATE INDEX "scheduler_table_leases_holder_idx"
  ON "scheduler_table_leases" ("holder_id");--> statement-breakpoint
ALTER TABLE "scheduler_table_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduler_table_leases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scheduler_table_leases_owner_access" ON "scheduler_table_leases" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scheduler_table_leases'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scheduler_table_leases'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scheduler_table_leases" FROM stella, PUBLIC;
--> statement-breakpoint
CREATE TABLE "scheduler_table_lease_activity" (
  "execution_token" text PRIMARY KEY,
  "holder_id" text NOT NULL,
  "job_id" text NOT NULL,
  "run_id" uuid NOT NULL UNIQUE,
  "claimed_at" timestamptz DEFAULT clock_timestamp() NOT NULL,
  "expires_at" timestamptz NOT NULL
);--> statement-breakpoint
CREATE INDEX "scheduler_table_lease_activity_holder_idx" ON "scheduler_table_lease_activity" ("holder_id");--> statement-breakpoint
CREATE INDEX "scheduler_table_lease_activity_expiry_idx" ON "scheduler_table_lease_activity" ("expires_at");--> statement-breakpoint
ALTER TABLE "scheduler_table_lease_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduler_table_lease_activity" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scheduler_table_lease_activity_owner_access" ON "scheduler_table_lease_activity" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scheduler_table_lease_activity'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scheduler_table_lease_activity'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scheduler_table_lease_activity" FROM stella, PUBLIC;
