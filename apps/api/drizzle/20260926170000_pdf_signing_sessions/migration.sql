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

-- Forced, so the owner login is held to policies too. It gets only what it
-- still does: the token lookups below read a session (they run as the
-- owner), and account deletion removes a deleted account's sessions.
ALTER TABLE "pdf_signing_sessions"
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The owner is named by the catalog rather than by role: its login name
-- differs from one deployment to the next.
CREATE POLICY "owner_select" ON "pdf_signing_sessions"
  AS PERMISSIVE FOR SELECT TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.pdf_signing_sessions'::regclass));--> statement-breakpoint

CREATE POLICY "owner_delete" ON "pdf_signing_sessions"
  AS PERMISSIVE FOR DELETE TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.pdf_signing_sessions'::regclass));--> statement-breakpoint

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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pdf_signing_sessions" TO stella;--> statement-breakpoint

-- The desktop's calls carry a token, not a user session, so the tenant a
-- token belongs to is found here and everything after runs under row
-- policies in that tenant's scope. Each lookup answers only for the exact
-- token hash the caller holds: it cannot list, and it returns the tenant's
-- ids, never a session's contents.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked and granted to the app role only; it writes nothing and returns only the tenant scope of the one open, unexpired handoff whose token hash the caller holds
CREATE FUNCTION "pdf_signing_handoff_scope"(p_handoff_token_hash text)
RETURNS TABLE (organization_id text, user_id text, workspace_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT w.organization_id::text, s.created_by, s.workspace_id
    FROM public.pdf_signing_sessions s
    JOIN public.workspaces w ON w.id = s.workspace_id
   WHERE s.handoff_token_hash = p_handoff_token_hash
     AND s.status = 'open'
     AND s.handoff_consumed_at IS NULL
     AND s.handoff_expires_at > pg_catalog.now()
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "pdf_signing_handoff_scope"(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "pdf_signing_handoff_scope"(text) TO stella;--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked and granted to the app role only; it writes nothing and returns only the tenant scope of the one session whose id and session token hash the caller holds
CREATE FUNCTION "pdf_signing_session_scope"(p_session_id uuid, p_session_token_hash text)
RETURNS TABLE (organization_id text, user_id text, workspace_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT w.organization_id::text, s.created_by, s.workspace_id
    FROM public.pdf_signing_sessions s
    JOIN public.workspaces w ON w.id = s.workspace_id
   WHERE s.id = p_session_id
     AND s.session_token_hash IS NOT NULL
     AND s.session_token_hash = p_session_token_hash
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "pdf_signing_session_scope"(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "pdf_signing_session_scope"(uuid, text) TO stella;
