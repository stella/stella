SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Apply only after the release allowing these optional reader grants is deployed.
CREATE POLICY "public_law_reader_access" ON "case_law_provision_extractions"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_provision_extraction_revisions_registry"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_provision_extraction_revisions"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "case_law_provision_extraction_in_scope"(varchar, varchar)
  TO "stella_public_law_reader";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "case_law_provision_extraction_input_digest"(text, date, text, text, boolean)
  TO "stella_public_law_reader";--> statement-breakpoint

GRANT SELECT (
  decision_id, desired_input_digest, work_status, generation, outcome,
  published_input_digest, published_jurisdiction, published_revision,
  published_projection_digest, payload_class, payload_class_input_digest
) ON TABLE "case_law_provision_extractions" TO "stella_public_law_reader";--> statement-breakpoint
GRANT SELECT (jurisdiction, revision)
  ON TABLE "case_law_provision_extraction_revisions_registry"
  TO "stella_public_law_reader";--> statement-breakpoint
GRANT SELECT (jurisdiction, min_current_revision)
  ON TABLE "case_law_provision_extraction_revisions"
  TO "stella_public_law_reader";--> statement-breakpoint
GRANT SELECT (
  span_role, print_piece_id, print_start, print_end, print_text,
  name_piece_id, name_start, name_end, name_text, selection,
  printed_work_identifier,
  target_document_id, target_status
) ON TABLE "case_law_provision_citations" TO "stella_public_law_reader";
