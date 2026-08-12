SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Additive rolling-deploy bridge: parent payload columns remain readable by
-- old tasks while new tasks materialize and drain these bounded chunk ledgers.
CREATE TABLE "account_deletion_effect_chunks" (
  "id" uuid PRIMARY KEY NOT NULL,
  "request_id" uuid NOT NULL,
  "chunk_index" integer NOT NULL,
  "effect_type" text DEFAULT 's3_delete' NOT NULL,
  "payload_hash" varchar(64) NOT NULL,
  "s3_keys" text[] NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamptz,
  "next_attempt_at" timestamptz,
  "error_message" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "account_deletion_effect_chunks_request_fk"
    FOREIGN KEY ("request_id") REFERENCES "account_deletion_requests"("id")
    ON DELETE CASCADE,
  CONSTRAINT "account_deletion_effect_chunks_effect_type_check"
    CHECK ("effect_type" = 's3_delete'),
  CONSTRAINT "account_deletion_effect_chunks_status_check"
    CHECK ("status" IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT "account_deletion_effect_chunks_attempt_nonnegative_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "account_deletion_effect_chunks_index_nonnegative_check"
    CHECK ("chunk_index" >= 0),
  CONSTRAINT "account_deletion_effect_chunks_payload_hash_check"
    CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "account_deletion_effect_chunks_payload_bound_check"
    CHECK (
      ("status" = 'completed' AND cardinality("s3_keys") = 0)
      OR
      ("status" <> 'completed' AND cardinality("s3_keys") BETWEEN 1 AND 50)
    ),
  CONSTRAINT "account_deletion_effect_chunks_lease_state_check"
    CHECK (
      ("status" = 'processing') =
      ("lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    ),
  CONSTRAINT "account_deletion_effect_chunks_retry_state_check"
    CHECK (("status" = 'failed') = ("next_attempt_at" IS NOT NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX "account_deletion_effect_chunks_request_index_uidx"
  ON "account_deletion_effect_chunks" ("request_id", "chunk_index");--> statement-breakpoint
CREATE INDEX "account_deletion_effect_chunks_pending_claim_idx"
  ON "account_deletion_effect_chunks" ("request_id", "chunk_index")
  WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "account_deletion_effect_chunks_failed_claim_idx"
  ON "account_deletion_effect_chunks"
  ("next_attempt_at", "request_id", "chunk_index")
  WHERE "status" = 'failed';--> statement-breakpoint
CREATE INDEX "account_deletion_effect_chunks_lease_expiry_idx"
  ON "account_deletion_effect_chunks"
  ("lease_expires_at", "request_id", "chunk_index")
  WHERE "status" = 'processing';--> statement-breakpoint

ALTER TABLE "account_deletion_effect_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "account_deletion_effect_chunks" FROM stella;--> statement-breakpoint

CREATE TABLE "entity_deletion_effect_chunks" (
  "id" uuid PRIMARY KEY NOT NULL,
  "request_id" uuid NOT NULL,
  "chunk_index" integer NOT NULL,
  "effect_type" text DEFAULT 's3_delete' NOT NULL,
  "payload_hash" varchar(64) NOT NULL,
  "s3_keys" text[] NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamptz,
  "next_attempt_at" timestamptz,
  "error_message" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "entity_deletion_effect_chunks_request_fk"
    FOREIGN KEY ("request_id") REFERENCES "entity_deletion_cleanup_requests"("id")
    ON DELETE CASCADE,
  CONSTRAINT "entity_deletion_effect_chunks_effect_type_check"
    CHECK ("effect_type" = 's3_delete'),
  CONSTRAINT "entity_deletion_effect_chunks_status_check"
    CHECK ("status" IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT "entity_deletion_effect_chunks_attempt_nonnegative_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "entity_deletion_effect_chunks_index_nonnegative_check"
    CHECK ("chunk_index" >= 0),
  CONSTRAINT "entity_deletion_effect_chunks_payload_hash_check"
    CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "entity_deletion_effect_chunks_payload_bound_check"
    CHECK (
      ("status" = 'completed' AND cardinality("s3_keys") = 0)
      OR
      ("status" <> 'completed' AND cardinality("s3_keys") BETWEEN 1 AND 50)
    ),
  CONSTRAINT "entity_deletion_effect_chunks_lease_state_check"
    CHECK (
      ("status" = 'processing') =
      ("lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    ),
  CONSTRAINT "entity_deletion_effect_chunks_retry_state_check"
    CHECK (("status" = 'failed') = ("next_attempt_at" IS NOT NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX "entity_deletion_effect_chunks_request_index_uidx"
  ON "entity_deletion_effect_chunks" ("request_id", "chunk_index");--> statement-breakpoint
CREATE INDEX "entity_deletion_effect_chunks_pending_claim_idx"
  ON "entity_deletion_effect_chunks" ("request_id", "chunk_index")
  WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "entity_deletion_effect_chunks_failed_claim_idx"
  ON "entity_deletion_effect_chunks"
  ("next_attempt_at", "request_id", "chunk_index")
  WHERE "status" = 'failed';--> statement-breakpoint
CREATE INDEX "entity_deletion_effect_chunks_lease_expiry_idx"
  ON "entity_deletion_effect_chunks"
  ("lease_expires_at", "request_id", "chunk_index")
  WHERE "status" = 'processing';--> statement-breakpoint

ALTER TABLE "entity_deletion_effect_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "entity_deletion_effect_chunks" FROM stella;--> statement-breakpoint
