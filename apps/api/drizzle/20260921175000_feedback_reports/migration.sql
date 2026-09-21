SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Filed feedback reports: a system table, not tenant data. There is no read
-- surface, no workspace column, and no policy admitting the request role. The
-- row is written before any delivery is attempted, so the receipt a reporter
-- is given always addresses something even when the deployment has no channel
-- configured.
--
-- Every text column holds sanitized content only. `user_id` and
-- `organization_id` record who filed a report for the maintainer's private
-- view; both drop to NULL when the account or firm is deleted, so erasing an
-- account never removes the report it produced.
CREATE TABLE "feedback_reports" (
  "id" uuid PRIMARY KEY NOT NULL,
  "receipt" text NOT NULL,
  "kind" text NOT NULL,
  "area" text NOT NULL,
  "title" text NOT NULL,
  "what_happened" text NOT NULL,
  "expected" text,
  "steps" text,
  "evidence" text,
  "context" jsonb,
  "server_version" text NOT NULL,
  "instance" text,
  "via" text NOT NULL,
  "user_id" text,
  "organization_id" varchar(128),
  "redactions" integer NOT NULL,
  "fingerprint" text NOT NULL,
  "deliveries" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "feedback_reports_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL,
  CONSTRAINT "feedback_reports_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
    ON DELETE SET NULL,
  -- Derived from FEEDBACK_KINDS.
  CONSTRAINT "feedback_reports_kind_check"
    CHECK ("kind" IN ('bug', 'idea', 'missing_capability', 'docs')),
  -- Derived from FEEDBACK_AREAS.
  CONSTRAINT "feedback_reports_area_check"
    CHECK ("area" IN ('matters', 'documents', 'templates', 'case_law', 'legislation', 'contacts', 'tasks', 'billing', 'chat', 'mcp_cli', 'web_app', 'desktop', 'other')),
  -- Derived from FEEDBACK_REPORT_VIAS.
  CONSTRAINT "feedback_reports_via_check"
    CHECK ("via" IN ('mcp', 'web', 'intake')),
  -- Crockford base32 without I, L, O and U: a receipt read back over the phone
  -- cannot be transcribed into a different one.
  CONSTRAINT "feedback_reports_receipt_format_check"
    CHECK ("receipt" ~ '^FB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$'),
  CONSTRAINT "feedback_reports_redactions_nonnegative_check"
    CHECK ("redactions" >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX "feedback_reports_receipt_uidx"
  ON "feedback_reports" ("receipt");--> statement-breakpoint

-- The dedupe lookup asks "this exact content, filed in the last day", so the
-- window bound leads with the fingerprint and orders by time inside it.
CREATE INDEX "feedback_reports_fingerprint_created_idx"
  ON "feedback_reports" ("fingerprint", "created_at" DESC);--> statement-breakpoint

ALTER TABLE "feedback_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- No policy and no grant: the request role must be able neither to read a
-- report nor to file one under another reporter's identity. Every access goes
-- through the owner connection in lib/db/feedback-report-store.ts.
REVOKE ALL PRIVILEGES ON TABLE "feedback_reports" FROM stella;
