SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
-- The coordinator applies this migration before recording its schema-phase receipt.
CREATE TABLE "scheduler_table_leases" (
  "table_name" text NOT NULL,
  "holder_kind" text NOT NULL,
  "holder_id" text NOT NULL,
  "mode" text NOT NULL,
  "requested_at" timestamptz DEFAULT clock_timestamp() NOT NULL,
  "granted_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "scheduler_table_leases_table_name_holder_kind_holder_id_pk" PRIMARY KEY ("table_name", "holder_kind", "holder_id"),
  CONSTRAINT "scheduler_table_leases_holder_kind_check" CHECK ("holder_kind" IN ('job', 'migration')),
  CONSTRAINT "scheduler_table_leases_mode_check" CHECK ("mode" IN ('shared', 'exclusive')),
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
CREATE TABLE "scheduler_table_lease_protocol" (
  "protocol" text PRIMARY KEY,
  "first_seen_at" timestamptz DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "scheduler_table_lease_protocol_singleton" CHECK ("protocol" = 'scheduler-table-leases-v1')
);--> statement-breakpoint
ALTER TABLE "scheduler_table_lease_protocol" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduler_table_lease_protocol" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scheduler_table_lease_protocol_owner_access" ON "scheduler_table_lease_protocol" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scheduler_table_lease_protocol'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scheduler_table_lease_protocol'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scheduler_table_lease_protocol" FROM stella, PUBLIC;
