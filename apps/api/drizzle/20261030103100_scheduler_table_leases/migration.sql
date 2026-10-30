SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
-- The pre-schema coordinator applies this same block before requesting leases.
-- The ledger replay must not lock the lease table for the schema transaction.
DO $$
BEGIN
  IF to_regclass('public.scheduler_table_leases') IS NULL THEN
CREATE TABLE IF NOT EXISTS "scheduler_table_leases" (
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
);
CREATE INDEX IF NOT EXISTS "scheduler_table_leases_queue_idx"
  ON "scheduler_table_leases" ("table_name", "requested_at", "holder_id", "expires_at");
CREATE INDEX IF NOT EXISTS "scheduler_table_leases_holder_idx"
  ON "scheduler_table_leases" ("holder_id");
ALTER TABLE "scheduler_table_leases" ENABLE ROW LEVEL SECURITY;
  END IF;
END
$$;
