SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

ALTER TABLE "usage_policies"
  ADD COLUMN "storage_bytes_per_assignment" bigint;--> statement-breakpoint
ALTER TABLE "usage_policies"
  ADD CONSTRAINT "usage_policies_storage_bytes_nonneg"
    CHECK ("storage_bytes_per_assignment" IS NULL OR "storage_bytes_per_assignment" >= 0) NOT VALID;--> statement-breakpoint

CREATE TABLE "organization_file_usage" (
  "organization_id" varchar(128) PRIMARY KEY NOT NULL,
  "committed_bytes" bigint DEFAULT 0 NOT NULL,
  "reserved_bytes" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "organization_file_usage_nonneg"
    CHECK ("committed_bytes" >= 0 AND "reserved_bytes" >= 0),
  CONSTRAINT "organization_file_usage_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade
);--> statement-breakpoint

CREATE TABLE "organization_file_objects" (
  "object_key" text PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "size_bytes" bigint NOT NULL,
  "pending_size_bytes" bigint,
  "write_id" text,
  "expected_sha256_hex" text,
  "reservation_started_at" timestamptz,
  "status" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "organization_file_objects_size_nonneg"
    CHECK ("size_bytes" >= 0),
  CONSTRAINT "organization_file_objects_pending_size_nonneg"
    CHECK ("pending_size_bytes" IS NULL OR "pending_size_bytes" >= 0),
  CONSTRAINT "organization_file_objects_pending_committed"
    CHECK ("status" = 'committed' OR "pending_size_bytes" IS NULL),
  CONSTRAINT "organization_file_objects_reservation_identity"
    CHECK (("write_id" IS NULL AND "reservation_started_at" IS NULL AND "expected_sha256_hex" IS NULL AND "pending_size_bytes" IS NULL) OR ("write_id" IS NOT NULL AND "reservation_started_at" IS NOT NULL)),
  CONSTRAINT "organization_file_objects_status_domain"
    CHECK ("status" IN ('reserved', 'committed')),
  CONSTRAINT "organization_file_objects_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade
);--> statement-breakpoint

CREATE INDEX "organization_file_objects_org_status_key_idx"
  ON "organization_file_objects" ("organization_id", "status", "object_key");--> statement-breakpoint

ALTER TABLE "organization_file_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_file_usage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_file_objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_file_objects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE "organization_file_usage" FROM "stella";--> statement-breakpoint
GRANT SELECT ON TABLE "organization_file_usage" TO "stella";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "organization_file_objects" FROM "stella";--> statement-breakpoint
GRANT SELECT ON TABLE "organization_file_objects" TO "stella";--> statement-breakpoint

CREATE POLICY "organization_file_usage_owner_access"
  ON "organization_file_usage" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.organization_file_usage'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.organization_file_usage'::regclass));--> statement-breakpoint
CREATE POLICY "organization_file_usage_select"
  ON "organization_file_usage" AS PERMISSIVE FOR SELECT TO "stella"
  USING ("organization_id" = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

CREATE POLICY "organization_file_objects_owner_access"
  ON "organization_file_objects" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.organization_file_objects'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.organization_file_objects'::regclass));--> statement-breakpoint
CREATE POLICY "organization_file_objects_select"
  ON "organization_file_objects" AS PERMISSIVE FOR SELECT TO "stella"
  USING ("organization_id" = (SELECT current_setting('app.organization_id', true)));
