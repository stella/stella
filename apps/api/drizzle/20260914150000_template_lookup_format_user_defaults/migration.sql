SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A member's own choice among the organization's saved company specification
-- formats. The organization default (`template_lookup_formats.preference =
-- 'default'`) stays the firm's answer for everyone who has not chosen; this
-- table is the member's answer for themselves, so the effective format
-- resolves user -> organization -> built-in.
--
-- Additive only: nothing reads this table until the new tasks roll out, and
-- the tasks still serving the old build resolve the organization default
-- exactly as before.
CREATE TABLE "template_lookup_format_user_defaults" (
  "user_id" text NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "registry" text NOT NULL,
  "format_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  -- The columns that identify the preference are the key, so a member holds at
  -- most one choice per registry and a repeated save converges on the row
  -- instead of racing a read-before-insert.
  CONSTRAINT "template_lookup_format_user_defaults_pkey"
    PRIMARY KEY ("user_id", "organization_id", "registry"),
  CONSTRAINT "template_lookup_format_user_defaults_user_id_fk"
    FOREIGN KEY ("user_id")
    REFERENCES "user"("id")
    ON DELETE CASCADE,
  CONSTRAINT "template_lookup_format_user_defaults_org_id_fk"
    FOREIGN KEY ("organization_id")
    REFERENCES "organization"("id")
    ON DELETE CASCADE,
  -- Deleting a saved format clears every member's choice of it rather than
  -- leaving a preference pointing at a format that no longer exists.
  CONSTRAINT "template_lookup_format_user_defaults_format_id_fk"
    FOREIGN KEY ("format_id")
    REFERENCES "template_lookup_formats"("id")
    ON DELETE CASCADE
);--> statement-breakpoint

-- That cascade has to find the rows pointing at the deleted format; the key
-- leads with the member, so nothing else indexes this column.
CREATE INDEX "template_lookup_format_user_defaults_format_idx"
  ON "template_lookup_format_user_defaults" ("format_id");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON "template_lookup_format_user_defaults" TO stella;--> statement-breakpoint

ALTER TABLE "template_lookup_format_user_defaults"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- A personal preference about one firm's formats. The member is the access
-- boundary, and the organization is pinned too, so somebody who belongs to
-- several firms reaches only the rows their current session's firm owns and a
-- handler that forgets the organization filter still cannot cross firms. The
-- INSERT and UPDATE checks re-apply the pin on write, so a row cannot be moved
-- to another member or another firm.
CREATE POLICY "user_select"
  ON "template_lookup_format_user_defaults"
  AS PERMISSIVE FOR SELECT TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );--> statement-breakpoint

CREATE POLICY "user_insert"
  ON "template_lookup_format_user_defaults"
  AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );--> statement-breakpoint

CREATE POLICY "user_update"
  ON "template_lookup_format_user_defaults"
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
  ON "template_lookup_format_user_defaults"
  AS PERMISSIVE FOR DELETE TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );
