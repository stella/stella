-- requires: 20261010212100_case_law_publication_filter
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

CREATE VIEW "case_law_published_decisions" AS
SELECT *
FROM "case_law_decisions"
WHERE (redacted_at IS NULL AND jsonb_extract_path_text(metadata, '_stellaPartialObservation', 'isListingOnly') is distinct from 'true');--> statement-breakpoint

CREATE VIEW "case_law_unredacted_decisions" AS
SELECT *
FROM "case_law_decisions"
WHERE redacted_at IS NULL;--> statement-breakpoint

-- generated case-law decision view grants: start
GRANT SELECT ("id", "source_id", "case_number", "case_number_type", "slug", "ecli", "citation_key", "docket_family_key", "court", "court_id", "country", "language", "language_group_key", "decision_date", "decision_type", "fulltext", "sections", "document_ast", "analysis", "source_url", "document_url", "metadata", "redacted_at", "citation_authority", "citation_count", "text_s3_key", "ast_s3_key", "content_hash", "indexed_hash", "created_at", "updated_at") ON TABLE "case_law_published_decisions", "case_law_unredacted_decisions" TO "stella_public_law_reader";--> statement-breakpoint

GRANT SELECT ON TABLE "case_law_published_decisions", "case_law_unredacted_decisions" TO "stella_caselaw_reader";--> statement-breakpoint

GRANT SELECT ON TABLE "case_law_published_decisions", "case_law_unredacted_decisions" TO "stella";--> statement-breakpoint

GRANT SELECT ON TABLE "case_law_published_decisions", "case_law_unredacted_decisions" TO "stella_ingestion";
-- generated case-law decision view grants: end
