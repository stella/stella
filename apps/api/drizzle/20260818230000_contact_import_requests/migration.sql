SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "contact_import_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "idempotency_key" varchar(128) NOT NULL,
  "request_fingerprint" varchar(64) NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "contact_import_requests_key_nonempty_check"
    CHECK (length("idempotency_key") > 0),
  CONSTRAINT "contact_import_requests_fingerprint_check"
    CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint

ALTER TABLE "contact_import_requests"
  ADD CONSTRAINT "contact_import_requests_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "contact_import_requests"
  ADD CONSTRAINT "contact_import_requests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id")
  ON DELETE CASCADE;--> statement-breakpoint

CREATE UNIQUE INDEX "contact_import_requests_org_user_key_uidx"
  ON "contact_import_requests"
  ("organization_id", "user_id", "idempotency_key");--> statement-breakpoint

ALTER TABLE "contact_import_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "contact_import_requests" TO stella;--> statement-breakpoint

CREATE POLICY "organization_select"
  ON "contact_import_requests"
  AS PERMISSIVE FOR SELECT TO stella
  USING (
    organization_id = (
      SELECT current_setting('app.organization_id', true)
    )
  );--> statement-breakpoint

CREATE POLICY "organization_insert"
  ON "contact_import_requests"
  AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (
    organization_id = (
      SELECT current_setting('app.organization_id', true)
    )
  );--> statement-breakpoint

CREATE POLICY "organization_update"
  ON "contact_import_requests"
  AS PERMISSIVE FOR UPDATE TO stella
  USING (
    organization_id = (
      SELECT current_setting('app.organization_id', true)
    )
  );--> statement-breakpoint

CREATE POLICY "organization_delete"
  ON "contact_import_requests"
  AS PERMISSIVE FOR DELETE TO stella
  USING (
    organization_id = (
      SELECT current_setting('app.organization_id', true)
    )
  );
