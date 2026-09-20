SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Short-lived objects for redlining two DOCX files stella does not store: the
-- two staged inputs and the redline the comparison writes. Nothing here becomes
-- a document, a version, or matter content, so there is no `workspace_id` and
-- no reference to one.
--
-- Additive only: the table is empty until the new tasks roll out, and tasks
-- still serving the old build never read it.
CREATE TABLE "file_comparison_uploads" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "declared_name" varchar(255) NOT NULL,
  "declared_size" bigint NOT NULL,
  "declared_sha256" varchar(64),
  "status" text DEFAULT 'pending' NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "file_comparison_uploads_organization_fk"
    FOREIGN KEY ("organization_id")
    REFERENCES "organization"("id")
    ON DELETE CASCADE,
  CONSTRAINT "file_comparison_uploads_user_fk"
    FOREIGN KEY ("user_id")
    REFERENCES "user"("id")
    ON DELETE CASCADE,
  CONSTRAINT "file_comparison_uploads_kind_check"
    CHECK ("kind" in ('input', 'redline')),
  CONSTRAINT "file_comparison_uploads_status_check"
    CHECK ("status" in ('pending', 'ready', 'consumed', 'failed')),
  -- An input is verified against the checksum it declared; a redline has none
  -- to declare. Neither half-state is representable.
  CONSTRAINT "file_comparison_uploads_sha256_check"
    CHECK (("kind" = 'input') = ("declared_sha256" IS NOT NULL))
);--> statement-breakpoint

-- The organization storage census walks the table in this order.
CREATE INDEX "file_comparison_uploads_org_created_idx"
  ON "file_comparison_uploads" ("organization_id", "created_at");--> statement-breakpoint

-- The sweep reads only what has expired, across every organization.
CREATE INDEX "file_comparison_uploads_expires_idx"
  ON "file_comparison_uploads" ("expires_at");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON "file_comparison_uploads" TO stella;--> statement-breakpoint

ALTER TABLE "file_comparison_uploads"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- One person's staged bytes inside one firm. The member is the access
-- boundary, and the organization is pinned too, so somebody who belongs to
-- several firms reaches only the rows their current session's firm owns and a
-- handler that forgets the organization filter still cannot cross firms. The
-- INSERT and UPDATE checks re-apply the pin on write, so a row cannot be moved
-- to another member or another firm.
CREATE POLICY "user_select"
  ON "file_comparison_uploads"
  AS PERMISSIVE FOR SELECT TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );--> statement-breakpoint

CREATE POLICY "user_insert"
  ON "file_comparison_uploads"
  AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );--> statement-breakpoint

CREATE POLICY "user_update"
  ON "file_comparison_uploads"
  AS PERMISSIVE FOR UPDATE TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  )
  WITH CHECK (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );--> statement-breakpoint

CREATE POLICY "user_delete"
  ON "file_comparison_uploads"
  AS PERMISSIVE FOR DELETE TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );
