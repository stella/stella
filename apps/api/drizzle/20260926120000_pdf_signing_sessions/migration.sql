SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- One browser-to-desktop PDF signing exchange: the handoff the deep link
-- carries, the session token the desktop redeems it for, the certificate and
-- signing time the two signing phases must agree on, and the version the
-- signature produced.
--
-- Additive only: the table is empty until the new tasks roll out, and tasks
-- still serving the old build never read it.
CREATE TABLE "pdf_signing_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "property_id" uuid NOT NULL,
  "base_version_id" uuid NOT NULL,
  "finalized_version_id" uuid,
  "created_by" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "close_reason" text,
  "handoff_token_hash" varchar(64) NOT NULL,
  "handoff_expires_at" timestamptz NOT NULL,
  "handoff_consumed_at" timestamptz,
  "session_token_hash" varchar(64),
  "token_expires_at" timestamptz NOT NULL,
  "reason" text,
  "location" text,
  "signer_certificate_der" bytea,
  "signer_certificate_chain" jsonb,
  "signing_time" timestamptz,
  "stamp" jsonb,
  "digest_hex" varchar(64),
  "signed_attributes" bytea,
  "placeholder_size" integer,
  "signature" bytea,
  "finalize_attempts" integer DEFAULT 0 NOT NULL,
  "finalize_lease_expires_at" timestamptz,
  "key_type" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "closed_at" timestamptz,
  CONSTRAINT "pdf_signing_sessions_status_check"
    CHECK ("status" in ('open', 'finalized', 'cancelled')),
  -- A reason is only meaningful on a cancelled exchange, and the vocabulary is
  -- what the browser branches on to explain the outcome.
  CONSTRAINT "pdf_signing_sessions_close_reason_check"
    CHECK ("close_reason" is null or "close_reason" in ('user_cancelled', 'base_version_diverged', 'digest_mismatch', 'unsupported_platform', 'certificate_rejected', 'certificate_revoked', 'certified_document', 'expired', 'signature_invalid', 'signing_failed', 'stamp_overflow', 'stamp_unrenderable', 'would_break_signatures')),
  CONSTRAINT "pdf_signing_sessions_finalize_attempts_check"
    CHECK ("finalize_attempts" >= 0),
  CONSTRAINT "pdf_signing_sessions_key_type_check"
    CHECK ("key_type" is null or "key_type" in ('RSA', 'EC'))
);--> statement-breakpoint

ALTER TABLE "pdf_signing_sessions"
  ADD CONSTRAINT "pdf_signing_sessions_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "pdf_signing_sessions"
  ADD CONSTRAINT "pdf_signing_sessions_base_version_id_entity_versions_id_fk"
  FOREIGN KEY ("base_version_id") REFERENCES "entity_versions"("id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "pdf_signing_sessions"
  ADD CONSTRAINT "pdf_signing_sessions_created_by_user_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "user"("id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "pdf_signing_sessions"
  ADD CONSTRAINT "pdf_signing_sessions_entity_workspace_fk"
  FOREIGN KEY ("entity_id","workspace_id")
  REFERENCES "entities"("id","workspace_id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "pdf_signing_sessions"
  ADD CONSTRAINT "pdf_signing_sessions_property_workspace_fk"
  FOREIGN KEY ("property_id","workspace_id")
  REFERENCES "properties"("id","workspace_id")
  ON DELETE CASCADE;--> statement-breakpoint

-- The signed version may be withdrawn later; the exchange that produced it
-- stays as an audit trail with a null pointer rather than disappearing.
ALTER TABLE "pdf_signing_sessions"
  ADD CONSTRAINT "pdf_signing_sessions_finalized_version_fk"
  FOREIGN KEY ("finalized_version_id") REFERENCES "entity_versions"("id")
  ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX "pdf_signing_sessions_workspace_id_idx"
  ON "pdf_signing_sessions" ("workspace_id");--> statement-breakpoint

CREATE INDEX "pdf_signing_sessions_entity_id_idx"
  ON "pdf_signing_sessions" ("entity_id");--> statement-breakpoint

-- Redemption and every later call look the exchange up by token hash.
CREATE UNIQUE INDEX "pdf_signing_sessions_handoff_token_hash_uidx"
  ON "pdf_signing_sessions" ("handoff_token_hash");--> statement-breakpoint

CREATE UNIQUE INDEX "pdf_signing_sessions_session_token_hash_uidx"
  ON "pdf_signing_sessions" ("session_token_hash")
  WHERE "session_token_hash" IS NOT NULL;--> statement-breakpoint

-- One live exchange per person per file field.
CREATE UNIQUE INDEX "pdf_signing_sessions_open_uidx"
  ON "pdf_signing_sessions" ("created_by", "entity_id", "property_id")
  WHERE "status" = 'open';--> statement-breakpoint

ALTER TABLE "pdf_signing_sessions"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "workspace_select" ON "pdf_signing_sessions"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint

CREATE POLICY "workspace_insert" ON "pdf_signing_sessions"
  AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint

CREATE POLICY "workspace_update" ON "pdf_signing_sessions"
  AS PERMISSIVE FOR UPDATE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint

CREATE POLICY "workspace_delete" ON "pdf_signing_sessions"
  AS PERMISSIVE FOR DELETE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pdf_signing_sessions" TO stella;
