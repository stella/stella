SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "office_file_evidence" (
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "entity_version_id" uuid NOT NULL,
  "field_id" uuid NOT NULL,
  "source_file_id" uuid NOT NULL,
  "source_sha256_hex" varchar(64) NOT NULL,
  "format" text NOT NULL,
  "parser_version" integer NOT NULL,
  "status" text NOT NULL,
  "claim_token" uuid,
  "claim_expires_at" timestamptz,
  "payload_ciphertext" bytea,
  "payload_iv" bytea,
  "block_count" integer NOT NULL,
  "error_code" varchar(64),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "office_file_evidence_format_check"
    CHECK ("format" IN ('xlsx', 'pptx')),
  CONSTRAINT "office_file_evidence_status_check"
    CHECK ("status" IN ('processing', 'available', 'unavailable')),
  CONSTRAINT "office_file_evidence_parser_version_check"
    CHECK ("parser_version" > 0),
  CONSTRAINT "office_file_evidence_block_count_check"
    CHECK ("block_count" >= 0 AND "block_count" <= 160),
  CONSTRAINT "office_file_evidence_source_hash_check"
    CHECK ("source_sha256_hex" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "office_file_evidence_payload_state_check" CHECK (
    (
      "status" = 'processing'
      AND "claim_token" IS NOT NULL
      AND "claim_expires_at" IS NOT NULL
      AND "payload_ciphertext" IS NULL
      AND "payload_iv" IS NULL
      AND "block_count" = 0
      AND "error_code" IS NULL
    ) OR (
      "status" = 'available'
      AND "claim_token" IS NULL
      AND "claim_expires_at" IS NULL
      AND "payload_ciphertext" IS NOT NULL
      AND "payload_iv" IS NOT NULL
      AND "error_code" IS NULL
    ) OR (
      "status" = 'unavailable'
      AND "claim_token" IS NULL
      AND "claim_expires_at" IS NULL
      AND "payload_ciphertext" IS NULL
      AND "payload_iv" IS NULL
      AND "block_count" = 0
      AND "error_code" IN ('parse_failed', 'resource_limit')
    )
  )
);--> statement-breakpoint

ALTER TABLE "office_file_evidence"
  ADD CONSTRAINT "office_file_evidence_organization_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "office_file_evidence"
  ADD CONSTRAINT "office_file_evidence_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "office_file_evidence"
  ADD CONSTRAINT "office_file_evidence_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id")
  REFERENCES "workspaces"("id", "organization_id")
  ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "office_file_evidence"
  ADD CONSTRAINT "office_file_evidence_entity_workspace_fk"
  FOREIGN KEY ("entity_id", "workspace_id")
  REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "office_file_evidence"
  ADD CONSTRAINT "office_file_evidence_version_fk"
  FOREIGN KEY ("entity_version_id") REFERENCES "entity_versions"("id")
  ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "office_file_evidence"
  ADD CONSTRAINT "office_file_evidence_field_workspace_fk"
  FOREIGN KEY ("field_id", "workspace_id")
  REFERENCES "fields"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint

CREATE UNIQUE INDEX "office_file_evidence_source_uidx"
  ON "office_file_evidence" (
    "organization_id", "workspace_id", "entity_version_id", "field_id",
    "source_file_id", "source_sha256_hex", "parser_version"
  );--> statement-breakpoint
ALTER TABLE "office_file_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "office_file_evidence" TO stella;--> statement-breakpoint

CREATE POLICY "office_file_evidence_workspace_select"
  ON "office_file_evidence" AS PERMISSIVE FOR SELECT TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "office_file_evidence_workspace_insert"
  ON "office_file_evidence" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "office_file_evidence_workspace_update"
  ON "office_file_evidence" AS PERMISSIVE FOR UPDATE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "office_file_evidence_workspace_delete"
  ON "office_file_evidence" AS PERMISSIVE FOR DELETE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));
