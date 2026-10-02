-- requires: 20261003123500_case_law_replay_receipts
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "eu_completion_receipts" (
  "id" text NOT NULL,
  "source_id" uuid NOT NULL,
  "decision_id" uuid NOT NULL,
  "mode" text NOT NULL,
  "parser_version" integer NOT NULL,
  "status" text NOT NULL,
  "target" text,
  "claimed_source_hash" text,
  "completion_source_hash" text,
  "claimed_observation_order" bigint,
  "claimed_fingerprint" text,
  "payload" text,
  "payload_hash" text,
  "provenance" jsonb,
  "detail" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "attempt_state" text DEFAULT 'idle' NOT NULL,
  "systemic_failures" integer DEFAULT 0 NOT NULL,
  "systemic_progress" bigint DEFAULT 0 NOT NULL,
  "refusal_count" integer DEFAULT 0 NOT NULL,
  "refusal_progress" bigint DEFAULT 0 NOT NULL,
  "refusal_hold_until" timestamptz,
  "mirror_waits" integer DEFAULT 0 NOT NULL,
  "retry_at" timestamptz,
  "written_at" timestamptz,
  "written_source_hash" text,
  "written_observation_order" bigint,
  "written_parser_version" integer,
  "superseded_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "eu_completion_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "eu_completion_receipts_approval_proof_key" UNIQUE ("id", "source_id", "parser_version", "mode", "status", "completed_at"),
  CONSTRAINT "eu_completion_receipts_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id") ON DELETE RESTRICT,
  CONSTRAINT "eu_completion_receipts_mode_check" CHECK ("mode" IN ('dry-run', 'apply')),
  CONSTRAINT "eu_completion_receipts_target_check" CHECK ("target" IS NULL OR "target" IN ('formex', 'full')),
  CONSTRAINT "eu_completion_receipts_attempt_state_check" CHECK ("attempt_state" IN ('idle', 'picked-up', 'repair')),
  CONSTRAINT "eu_completion_receipts_attempts_check" CHECK ("attempts" >= 0 AND "parser_version" >= 0 AND "systemic_failures" >= 0 AND "systemic_progress" >= 0 AND "refusal_count" >= 0 AND "refusal_progress" >= 0 AND "mirror_waits" >= 0),
  CONSTRAINT "eu_completion_receipts_payload_check" CHECK ("payload" IS NULL OR octet_length("payload") <= 16777216),
  CONSTRAINT "eu_completion_receipts_provenance_check" CHECK ("provenance" IS NULL OR (jsonb_typeof("provenance") = 'object' AND octet_length("provenance"::text) <= 32768)),
  CONSTRAINT "eu_completion_receipts_fetched_check" CHECK ("status" <> 'fetched' OR ("payload" IS NOT NULL AND "payload_hash" IS NOT NULL AND "claimed_fingerprint" IS NOT NULL AND "target" IS NOT NULL)),
  CONSTRAINT "eu_completion_receipts_retry_check" CHECK ("status" NOT IN ('failed-backoff', 'failed', 'superseded-by-crawl') OR "retry_at" IS NOT NULL),
  CONSTRAINT "eu_completion_receipts_refusal_check" CHECK ("status" <> 'publisher-refused' OR ("completed_at" IS NULL AND "retry_at" IS NOT NULL) OR ("completed_at" IS NOT NULL AND "retry_at" IS NULL)),
  CONSTRAINT "eu_completion_receipts_written_check" CHECK ("written_at" IS NULL OR ("mode" = 'apply' AND "written_parser_version" IS NOT NULL AND "written_source_hash" IS NOT NULL AND "written_observation_order" IS NOT NULL)),
  CONSTRAINT "eu_completion_receipts_status_check" CHECK ("status" IN ('pending', 'fetched', 'applied', 'unchanged', 'review-required', 'publisher-refused', 'failed-backoff', 'failed', 'dry-run', 'too-large', 'publisher-gone', 'superseded-by-crawl', 'withdrawn'))
);--> statement-breakpoint
ALTER TABLE "eu_completion_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eu_completion_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "eu_completion_receipts_owner_access" ON "eu_completion_receipts" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_receipts'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_receipts'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "eu_completion_receipts" FROM stella;--> statement-breakpoint
CREATE TABLE "eu_completion_request_hours" (
  "hour" timestamptz NOT NULL,
  "requests" integer NOT NULL,
  CONSTRAINT "eu_completion_request_hours_pkey" PRIMARY KEY ("hour"),
  CONSTRAINT "eu_completion_request_hours_count_check" CHECK ("requests" >= 0 AND "requests" <= 3600)
);--> statement-breakpoint
ALTER TABLE "eu_completion_request_hours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eu_completion_request_hours" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "eu_completion_request_hours_owner_access" ON "eu_completion_request_hours" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_request_hours'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_request_hours'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "eu_completion_request_hours" FROM stella;--> statement-breakpoint
CREATE TABLE "eu_completion_approvals" (
  "source_id" uuid NOT NULL,
  "parser_version" integer NOT NULL,
  "supervised_receipt_id" text NOT NULL,
  "evidence_ref" text NOT NULL,
  "supervised_by" text NOT NULL,
  "supervised_at" timestamptz NOT NULL,
  "approved_by" text NOT NULL,
  "approved_at" timestamptz NOT NULL,
  "proof_mode" text NOT NULL,
  "proof_status" text NOT NULL,
  "proof_completed_at" timestamptz NOT NULL,
  "reviewed_counts" jsonb NOT NULL,
  CONSTRAINT "eu_completion_approvals_pkey" PRIMARY KEY ("source_id", "parser_version"),
  CONSTRAINT "eu_completion_approvals_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id") ON DELETE RESTRICT,
  CONSTRAINT "eu_completion_approvals_receipt_fk" FOREIGN KEY ("supervised_receipt_id", "source_id", "parser_version", "proof_mode", "proof_status", "proof_completed_at") REFERENCES "eu_completion_receipts"("id", "source_id", "parser_version", "mode", "status", "completed_at") ON DELETE RESTRICT,
  CONSTRAINT "eu_completion_approvals_proof_check" CHECK ("proof_mode" = 'dry-run' AND "proof_status" = 'dry-run' AND "proof_completed_at" <= "supervised_at"),
  CONSTRAINT "eu_completion_approvals_reviewed_check" CHECK (jsonb_typeof("reviewed_counts") = 'object' AND jsonb_typeof("reviewed_counts"->'reviewed') = 'number' AND jsonb_typeof("reviewed_counts"->'accepted') = 'number' AND jsonb_typeof("reviewed_counts"->'requiresReview') = 'number' AND ("reviewed_counts"->>'reviewed')::numeric BETWEEN 1 AND 1000000 AND ("reviewed_counts"->>'accepted')::numeric BETWEEN 0 AND 1000000 AND ("reviewed_counts"->>'requiresReview')::numeric BETWEEN 0 AND 1000000 AND ("reviewed_counts"->>'reviewed')::numeric = trunc(("reviewed_counts"->>'reviewed')::numeric) AND ("reviewed_counts"->>'accepted')::numeric = trunc(("reviewed_counts"->>'accepted')::numeric) AND ("reviewed_counts"->>'requiresReview')::numeric = trunc(("reviewed_counts"->>'requiresReview')::numeric) AND ("reviewed_counts"->>'accepted')::numeric + ("reviewed_counts"->>'requiresReview')::numeric = ("reviewed_counts"->>'reviewed')::numeric AND "reviewed_counts" ?& ARRAY['reviewed','accepted','requiresReview']),
  CONSTRAINT "eu_completion_approvals_evidence_check" CHECK ("parser_version" >= 0 AND length(trim("evidence_ref")) BETWEEN 1 AND 2048 AND length(trim("supervised_by")) BETWEEN 1 AND 128 AND length(trim("approved_by")) BETWEEN 1 AND 128 AND "supervised_at" <= "approved_at")
);--> statement-breakpoint
ALTER TABLE "eu_completion_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eu_completion_approvals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "eu_completion_approvals_owner_access" ON "eu_completion_approvals" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_approvals'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_approvals'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "eu_completion_approvals" FROM stella;--> statement-breakpoint
CREATE TABLE "eu_completion_controls" (
  "key" text NOT NULL,
  "source_id" uuid,
  "state" text DEFAULT 'off' NOT NULL,
  "batch" jsonb,
  "cursor" uuid,
  "completed_rows" bigint DEFAULT 0 NOT NULL,
  "healthy_rows" bigint DEFAULT 0 NOT NULL,
  "ticks_without_progress" integer DEFAULT 0 NOT NULL,
  "last_completed_at" timestamptz,
  "changed_by" text,
  "changed_at" timestamptz,
  CONSTRAINT "eu_completion_controls_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "eu_completion_controls_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id") ON DELETE RESTRICT,
  CONSTRAINT "eu_completion_controls_state_check" CHECK ("state" IN ('off', 'on')),
  CONSTRAINT "eu_completion_controls_operator_check" CHECK ("state" <> 'on' OR ("changed_by" IS NOT NULL AND length(trim("changed_by")) BETWEEN 1 AND 128 AND "changed_at" IS NOT NULL)),
  CONSTRAINT "eu_completion_controls_counts_check" CHECK ("completed_rows" >= 0 AND "healthy_rows" >= 0 AND "ticks_without_progress" >= 0)
);--> statement-breakpoint
ALTER TABLE "eu_completion_controls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eu_completion_controls" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "eu_completion_controls_owner_access" ON "eu_completion_controls" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_controls'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_controls'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "eu_completion_controls" FROM stella;--> statement-breakpoint
CREATE INDEX "eu_completion_receipts_due_idx" ON "eu_completion_receipts" ("source_id", "mode", "parser_version", "status", "retry_at", "decision_id");--> statement-breakpoint
CREATE INDEX "eu_completion_receipts_document_idx" ON "eu_completion_receipts" ("source_id", "decision_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX "eu_completion_receipts_retention_idx" ON "eu_completion_receipts" ("superseded_at", "id") WHERE "superseded_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "eu_completion_approvals_receipt_idx" ON "eu_completion_approvals" ("supervised_receipt_id");--> statement-breakpoint
