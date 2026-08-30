-- squawk-ignore-file constraint-missing-not-valid, adding-serial-primary-key-field
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - expands cleanup identity without deleting rows; transactional rollback restores the original primary key.
ALTER TABLE "buffer_object_cleanup_intents"
  DROP CONSTRAINT "buffer_object_cleanup_intents_pkey";--> statement-breakpoint
-- Rebuilding the key is required to allow one cleanup intent per deterministic object.
-- The lock and statement timeouts above make contention fail fast.
ALTER TABLE "buffer_object_cleanup_intents"
  ADD CONSTRAINT "buffer_object_cleanup_intents_pkey"
  PRIMARY KEY ("id", "object_key");--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Commit the primary-key change first, lift the timeouts for the concurrent
-- build, then restore and reopen a transaction for Drizzle's migration row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = '30min';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint

-- Drop only this migration's own index by name before recreating it. A cancelled concurrent
-- build leaves an INVALID index behind, which IF NOT EXISTS would preserve.
DROP INDEX CONCURRENTLY IF EXISTS "pending_uploads_email_ingest_recovery_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "pending_uploads_email_ingest_recovery_idx"
  ON "pending_uploads" ("claimed_at", "id")
  WHERE "status" IN ('scanning', 'failed')
    AND "purpose" = 'email_ingest'
    AND jsonb_array_length(
      COALESCE("purpose_data"->'recoveryObjectKeys', '[]'::jsonb)
    ) > 0;--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "pending_uploads_email_source_uidx";
--> statement-breakpoint
-- The API persists only a hash; legacy email-ingest rows without a source key
-- remain valid during the migration-first rollout.
-- squawk-ignore prefer-robust-stmts
CREATE UNIQUE INDEX CONCURRENTLY "pending_uploads_email_source_uidx"
  ON "pending_uploads" (
    "organization_id",
    "workspace_id",
    (("purpose_data"->>'sourceKey'))
  )
  WHERE "purpose" = 'email_ingest'
    AND "purpose_data"->>'sourceKey' IS NOT NULL;--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint

CREATE TABLE "email_ingest_effects" (
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source_upload_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "field_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "file_name" varchar(255) NOT NULL,
  "mime_type" varchar(255) NOT NULL,
  "encrypted" boolean NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "claimed_at" timestamptz,
  "claim_token" uuid,
  "last_error_type" varchar(128),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "email_ingest_effects_pkey"
    PRIMARY KEY ("source_upload_id", "entity_id", "kind"),
  CONSTRAINT "email_ingest_effects_kind_check"
    CHECK ("kind" IN (
      'extract',
      'start_flows',
      'pdf_derivative',
      'thumbnail_derivative'
    )),
  CONSTRAINT "email_ingest_effects_status_check"
    CHECK ("status" IN (
      'pending', 'processing', 'failed', 'completed', 'exhausted'
    )),
  CONSTRAINT "email_ingest_effects_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "email_ingest_effects_claim_state_check"
    CHECK (("status" = 'processing') = (
      "claimed_at" IS NOT NULL AND "claim_token" IS NOT NULL
    )),
  CONSTRAINT "email_ingest_effects_completion_state_check"
    CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL)),
  CONSTRAINT "email_ingest_effects_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE,
  CONSTRAINT "email_ingest_effects_entity_fk"
    FOREIGN KEY ("entity_id") REFERENCES "entities"("id")
    ON DELETE CASCADE,
  CONSTRAINT "email_ingest_effects_field_fk"
    FOREIGN KEY ("field_id") REFERENCES "fields"("id")
    ON DELETE CASCADE,
  CONSTRAINT "email_ingest_effects_workspace_organization_fk"
    FOREIGN KEY ("workspace_id", "organization_id")
    REFERENCES "workspaces"("id", "organization_id") ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX "email_ingest_effects_due_idx"
  ON "email_ingest_effects" ("next_attempt_at", "created_at", "entity_id")
  WHERE "status" IN ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "email_ingest_effects_processing_idx"
  ON "email_ingest_effects" ("claimed_at", "entity_id")
  WHERE "status" = 'processing';--> statement-breakpoint

ALTER TABLE "email_ingest_effects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "email_ingest_effects" FROM stella;--> statement-breakpoint
GRANT INSERT ON TABLE "email_ingest_effects" TO stella;--> statement-breakpoint
CREATE POLICY "email_ingest_effects_insert"
  ON "email_ingest_effects"
  AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ((CASE
    WHEN workspace_id = ANY(
      COALESCE(
        NULLIF(
          (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
          ''
        )::uuid[],
        ARRAY[]::uuid[]
      )
    ) THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));
