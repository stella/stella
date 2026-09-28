SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "sanctions_sources" (
  "id" text PRIMARY KEY NOT NULL,
  "issuer" text NOT NULL,
  "licence" text,
  "marker_url" text NOT NULL,
  "active_edition_id" uuid,
  "last_checked_at" timestamp with time zone,
  "last_successful_verified_at" timestamp with time zone,
  "last_failure_at" timestamp with time zone,
  "last_failure_code" text,
  "last_failure_previous_count" integer,
  "last_failure_next_count" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sanctions_sources_failure_code_allowed" CHECK (
    "last_failure_code" IS NULL OR "last_failure_code" IN (
      'access-denied', 'fetch-failed', 'metadata-invalid', 'parse-failed',
      'replacement-below-minimum', 'replacement-contracted',
      'replacement-stale', 'replacement-source-mismatch'
    )
  ),
  CONSTRAINT "sanctions_sources_failure_counts_nonnegative" CHECK (
    ("last_failure_previous_count" IS NULL OR "last_failure_previous_count" >= 0)
    AND ("last_failure_next_count" IS NULL OR "last_failure_next_count" >= 0)
  ),
  CONSTRAINT "sanctions_sources_failure_pair" CHECK (
    ("last_failure_at" IS NULL) = ("last_failure_code" IS NULL)
  )
);--> statement-breakpoint

CREATE TABLE "sanctions_editions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "source_id" text NOT NULL REFERENCES "sanctions_sources"("id") ON DELETE restrict,
  "marker_key" text NOT NULL,
  "published_at" text NOT NULL,
  "file_id" text,
  "content_hash" text NOT NULL,
  "entry_count" integer NOT NULL,
  "state" text NOT NULL,
  "guard_code" text,
  "previous_entry_count" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activated_at" timestamp with time zone,
  CONSTRAINT "sanctions_editions_source_id_id_unique" UNIQUE("source_id", "id"),
  CONSTRAINT "sanctions_editions_state_allowed" CHECK (
    "state" IN ('staging', 'ready', 'rejected')
  ),
  CONSTRAINT "sanctions_editions_entry_count_nonnegative" CHECK (
    "entry_count" >= 0
    AND ("previous_entry_count" IS NULL OR "previous_entry_count" >= 0)
  ),
  CONSTRAINT "sanctions_editions_guard_shape" CHECK (
    ("state" = 'rejected') = ("guard_code" IS NOT NULL)
  ),
  CONSTRAINT "sanctions_editions_hash_shape" CHECK (
    "marker_key" ~ '^[0-9a-f]{64}$'
    AND "content_hash" ~ '^[0-9a-f]{64}$'
  )
);--> statement-breakpoint

ALTER TABLE "sanctions_sources" ADD CONSTRAINT "sanctions_sources_active_edition_fk"
  FOREIGN KEY ("id", "active_edition_id")
  REFERENCES "sanctions_editions"("source_id", "id") ON DELETE restrict;--> statement-breakpoint

CREATE UNIQUE INDEX "sanctions_editions_marker_content_idx"
  ON "sanctions_editions" ("source_id", "marker_key", "content_hash");--> statement-breakpoint
CREATE INDEX "sanctions_editions_source_created_idx"
  ON "sanctions_editions" ("source_id", "created_at");--> statement-breakpoint

CREATE TABLE "sanctions_entries" (
  "edition_id" uuid NOT NULL REFERENCES "sanctions_editions"("id") ON DELETE restrict,
  "source_entry_id" text NOT NULL,
  "content_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  CONSTRAINT "sanctions_entries_pkey" PRIMARY KEY("edition_id", "source_entry_id"),
  CONSTRAINT "sanctions_entries_hash_shape" CHECK (
    "content_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "sanctions_entries_payload_object" CHECK (
    jsonb_typeof("payload") = 'object'
  )
);--> statement-breakpoint

ALTER TABLE "sanctions_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_editions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_editions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "case_law_global_access" ON "sanctions_sources"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "sanctions_sources"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "sanctions_editions"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "sanctions_editions"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "sanctions_entries"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "sanctions_entries"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT ON "sanctions_sources", "sanctions_editions", "sanctions_entries"
  TO "stella";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "sanctions_sources", "sanctions_editions"
  TO "stella_ingestion";--> statement-breakpoint
GRANT SELECT, INSERT ON "sanctions_entries"
  TO "stella_ingestion";--> statement-breakpoint
