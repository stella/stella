SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "sanctions_sources" (
  "id" text PRIMARY KEY NOT NULL,
  "issuer" text NOT NULL,
  "licence" text,
  "marker_url" text NOT NULL,
  "active_edition_id" uuid,
  "held_edition_id" uuid,
  "held_guard_code" text,
  "held_at" timestamp with time zone,
  "held_previous_count" integer,
  "held_next_count" integer,
  "last_checked_at" timestamp with time zone,
  "last_successful_verified_at" timestamp with time zone,
  "last_failure_at" timestamp with time zone,
  "last_failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sanctions_sources_failure_code_allowed" CHECK (
    "last_failure_code" IS NULL OR "last_failure_code" IN (
      'access-denied', 'fetch-failed', 'metadata-invalid', 'parse-failed',
      'unexpected-error'
    )
  ),
  CONSTRAINT "sanctions_sources_failure_pair" CHECK (
    ("last_failure_at" IS NULL) = ("last_failure_code" IS NULL)
  ),
  CONSTRAINT "sanctions_sources_held_code_allowed" CHECK (
    "held_guard_code" IS NULL OR "held_guard_code" IN (
      'below-minimum', 'contracted', 'stale', 'source-mismatch'
    )
  ),
  CONSTRAINT "sanctions_sources_held_counts_nonnegative" CHECK (
    ("held_previous_count" IS NULL OR "held_previous_count" >= 0)
    AND ("held_next_count" IS NULL OR "held_next_count" >= 0)
  ),
  CONSTRAINT "sanctions_sources_held_shape" CHECK (
    ("held_at" IS NULL) = ("held_guard_code" IS NULL)
    AND ("held_edition_id" IS NULL) = ("held_guard_code" IS NULL)
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
  CONSTRAINT "sanctions_editions_guard_code_allowed" CHECK (
    "guard_code" IS NULL OR "guard_code" IN (
      'below-minimum', 'contracted', 'stale', 'source-mismatch',
      'invalid-stage', 'superseded'
    )
  ),
  CONSTRAINT "sanctions_editions_hash_shape" CHECK (
    "marker_key" ~ '^[0-9a-f]{64}$'
    AND "content_hash" ~ '^[0-9a-f]{64}$'
  )
);--> statement-breakpoint

ALTER TABLE "sanctions_sources" ADD CONSTRAINT "sanctions_sources_active_edition_fk"
  FOREIGN KEY ("id", "active_edition_id")
  REFERENCES "sanctions_editions"("source_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "sanctions_sources" ADD CONSTRAINT "sanctions_sources_held_edition_fk"
  FOREIGN KEY ("id", "held_edition_id")
  REFERENCES "sanctions_editions"("source_id", "id") ON DELETE restrict;--> statement-breakpoint

CREATE UNIQUE INDEX "sanctions_editions_marker_content_idx"
  ON "sanctions_editions" ("source_id", "marker_key", "content_hash");--> statement-breakpoint
CREATE INDEX "sanctions_editions_source_created_idx"
  ON "sanctions_editions" ("source_id", "created_at");--> statement-breakpoint

CREATE TABLE "sanctions_entry_payloads" (
  "content_hash" text PRIMARY KEY NOT NULL,
  "payload" jsonb NOT NULL,
  CONSTRAINT "sanctions_entry_payloads_hash_shape" CHECK (
    "content_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "sanctions_entry_payloads_payload_object" CHECK (
    jsonb_typeof("payload") = 'object'
  )
);--> statement-breakpoint

CREATE TABLE "sanctions_edition_entries" (
  "edition_id" uuid NOT NULL REFERENCES "sanctions_editions"("id") ON DELETE restrict,
  "source_entry_id" text NOT NULL,
  "content_hash" text NOT NULL,
  CONSTRAINT "sanctions_edition_entries_pkey" PRIMARY KEY("edition_id", "source_entry_id"),
  CONSTRAINT "sanctions_edition_entries_payload_fk" FOREIGN KEY ("content_hash") REFERENCES "sanctions_entry_payloads"("content_hash") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX "sanctions_edition_entries_content_hash_idx"
  ON "sanctions_edition_entries" ("content_hash");--> statement-breakpoint

ALTER TABLE "sanctions_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_editions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_entry_payloads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_edition_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_editions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_entry_payloads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sanctions_edition_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "case_law_global_access" ON "sanctions_sources"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "sanctions_sources"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "sanctions_editions"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "sanctions_editions"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "sanctions_entry_payloads"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "sanctions_entry_payloads"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "sanctions_edition_entries"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "sanctions_edition_entries"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT ON "sanctions_sources", "sanctions_editions", "sanctions_entry_payloads", "sanctions_edition_entries"
  TO "stella";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "sanctions_sources", "sanctions_editions"
  TO "stella_ingestion";--> statement-breakpoint
GRANT SELECT, INSERT ON "sanctions_entry_payloads", "sanctions_edition_entries"
  TO "stella_ingestion";--> statement-breakpoint
