-- requires: 20260926160000_case_law_provision_extraction_state
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_provision_citations"
  ADD COLUMN "applied_version_basis" text,
  ADD COLUMN "applied_version_date" date,
  ADD COLUMN "applied_version_date_relation" text,
  ADD COLUMN "applied_version_amendment_work_identifier" text,
  ADD COLUMN "applied_version_expression_date" date,
  ADD COLUMN "applied_version_expression_eli" text,
  ADD COLUMN "version_evidence_start" integer,
  ADD COLUMN "version_evidence_end" integer,
  ADD COLUMN "version_evidence_kind" text;--> statement-breakpoint

ALTER TABLE "case_law_provision_citations"
  ADD CONSTRAINT "provision_citations_applied_version_shape" CHECK (CASE
        WHEN "applied_version_basis" IS NULL OR "applied_version_basis" = 'not_stated'
          THEN num_nonnulls("applied_version_date", "applied_version_date_relation", "applied_version_amendment_work_identifier", "applied_version_expression_date", "applied_version_expression_eli", "version_evidence_start", "version_evidence_end", "version_evidence_kind") = 0
        WHEN "applied_version_basis" IN ('stated_date', 'stated_version') THEN
          num_nulls("version_evidence_start", "version_evidence_end", "version_evidence_kind") = 0
          AND "version_evidence_start" >= 0 AND "version_evidence_end" > "version_evidence_start"
          AND ("applied_version_expression_date" IS NULL) = ("applied_version_expression_eli" IS NULL)
          AND ("applied_version_expression_eli" IS NULL OR length("applied_version_expression_eli") > 0)
          AND CASE WHEN "applied_version_basis" = 'stated_date' THEN
            "applied_version_date" IS NOT NULL
            AND "applied_version_date_relation" IS NOT NULL
            AND "applied_version_date_relation" IN ('on', 'until', 'from')
            AND "applied_version_amendment_work_identifier" IS NULL
            AND "version_evidence_kind" = 'stated_date'
          ELSE
            "applied_version_date" IS NULL AND "applied_version_date_relation" IS NULL
            AND "applied_version_amendment_work_identifier" IS NOT NULL
            AND length("applied_version_amendment_work_identifier") > 0
            AND "version_evidence_kind" = 'stated_version'
          END
        ELSE false END) NOT VALID;--> statement-breakpoint

GRANT SELECT ("applied_version_basis", "applied_version_date", "applied_version_date_relation", "applied_version_amendment_work_identifier", "applied_version_expression_date", "applied_version_expression_eli", "version_evidence_start", "version_evidence_end", "version_evidence_kind") ON TABLE "case_law_provision_citations" TO "stella_public_law_reader";
