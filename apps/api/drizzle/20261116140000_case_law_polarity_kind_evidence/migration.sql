-- requires: 20260922120000_case_law_polarity_mixed
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Registered seed rules take their typed kind in the post-deploy online
-- repair (polarity-rule-kind); unmatched manual and model rules remain
-- stance. Retain the stance default until the previous release has drained:
-- its writers omit kind. Remove the default in a later contract migration.
-- Every check below is added NOT VALID and validated online.
ALTER TABLE "case_law_polarity_rules"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'stance';--> statement-breakpoint

ALTER TABLE "case_law_polarity_rules"
  ADD CONSTRAINT "polarity_rules_kind_values" CHECK ("kind" IN ('stance', 'form')) NOT VALID,
  ADD CONSTRAINT "polarity_rules_form_neutral" CHECK ("kind" <> 'form' OR "polarity" = 'neutral') NOT VALID;--> statement-breakpoint

ALTER TABLE "case_law_citations"
  ADD COLUMN "polarity_source" text,
  ADD COLUMN "polarity_classifier_version" text,
  ADD COLUMN "polarity_evidence_windows" jsonb,
  ADD COLUMN "polarity_confidence" double precision,
  ADD COLUMN "cited_part" text NOT NULL DEFAULT 'not-stated';--> statement-breakpoint

ALTER TABLE "case_law_citations"
  ADD CONSTRAINT "citations_polarity_source_values" CHECK ("polarity_source" IN ('rule', 'system-one', 'llm', 'review')) NOT VALID,
  ADD CONSTRAINT "citations_cited_part_values" CHECK ("cited_part" IN ('majority', 'dissent', 'concurrence', 'not-stated')) NOT VALID,
  ADD CONSTRAINT "citations_polarity_window_bounds" CHECK (
    CASE WHEN "polarity_evidence_windows" IS NULL THEN true
    WHEN jsonb_typeof("polarity_evidence_windows") <> 'array' THEN false
    ELSE jsonb_array_length("polarity_evidence_windows") > 0
      AND NOT jsonb_path_exists("polarity_evidence_windows", '$[*] ? (@.type() != "object" || !exists(@.start) || !exists(@.end) || @.start.type() != "number" || @.end.type() != "number" || @.start < 0 || @.end <= @.start || @.start > 2147483647 || @.end > 2147483647 || @.start % 1 != 0 || @.end % 1 != 0 || exists(@.keyvalue() ? (@.key != "start" && @.key != "end")))'::jsonpath)
    END
  ) NOT VALID,
  ADD CONSTRAINT "citations_polarity_confidence_bounds" CHECK ("polarity_confidence" >= 0 AND "polarity_confidence" <= 1) NOT VALID;
