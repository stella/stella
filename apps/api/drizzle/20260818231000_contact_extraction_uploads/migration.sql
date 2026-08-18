SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "contact_extraction_uploads" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "declared_name" varchar(255) NOT NULL,
  "declared_mime" varchar(255) NOT NULL,
  "declared_size" bigint NOT NULL,
  "declared_sha256" varchar(64) NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "claim_token" uuid,
  "processing_started_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "used_at" timestamptz,
  CONSTRAINT "contact_extraction_uploads_sha256_check"
    CHECK ("declared_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "contact_extraction_uploads_lifecycle_check"
    CHECK (
      ("status" = 'pending' AND "claim_token" IS NULL AND "processing_started_at" IS NULL AND "used_at" IS NULL)
      OR ("status" = 'processing' AND "claim_token" IS NOT NULL AND "processing_started_at" IS NOT NULL AND "used_at" IS NULL)
      OR ("status" = 'used' AND "claim_token" IS NULL AND "processing_started_at" IS NULL AND "used_at" IS NOT NULL)
    )
);--> statement-breakpoint

ALTER TABLE "contact_extraction_uploads"
  ADD CONSTRAINT "contact_extraction_uploads_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "contact_extraction_uploads"
  ADD CONSTRAINT "contact_extraction_uploads_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id")
  ON DELETE CASCADE;--> statement-breakpoint

CREATE INDEX "contact_extraction_uploads_org_user_expiry_idx"
  ON "contact_extraction_uploads"
  ("organization_id", "user_id", "expires_at");--> statement-breakpoint

ALTER TABLE "contact_extraction_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "contact_extraction_uploads" TO stella;--> statement-breakpoint

CREATE POLICY "organization_select"
  ON "contact_extraction_uploads"
  AS PERMISSIVE FOR SELECT TO stella
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

CREATE POLICY "organization_insert"
  ON "contact_extraction_uploads"
  AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

CREATE POLICY "organization_update"
  ON "contact_extraction_uploads"
  AS PERMISSIVE FOR UPDATE TO stella
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

CREATE POLICY "organization_delete"
  ON "contact_extraction_uploads"
  AS PERMISSIVE FOR DELETE TO stella
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));
