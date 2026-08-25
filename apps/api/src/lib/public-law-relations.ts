/**
 * Exact PostgreSQL columns exposed through the public-law reader role.
 *
 * Every relation is column-restricted. Operational cursors, source config,
 * raw publisher payloads, ingestion leases and index-repair state stay on the
 * owning service side. The runtime attestation and migration tests derive
 * from this map, so adding a field requires one explicit public-data decision.
 */
export const PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT = {
  caseLawCitations: "case_law_citations",
  caseLawCorpusIndexProjections: "case_law_corpus_index_projections",
  caseLawDecisionIdentifiers: "case_law_decision_identifiers",
  caseLawDecisions: "case_law_decisions",
  caseLawProvisionCitations: "case_law_provision_citations",
  caseLawSources: "case_law_sources",
  corpusIndexGenerations: "corpus_index_generations",
  legislationDocuments: "legislation_documents",
  legislationSources: "legislation_sources",
} as const;

export type PublicLawRelation =
  (typeof PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT)[keyof typeof PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT];

export const PUBLIC_CASE_LAW_SCHEMA_IMPORTS = Object.keys(
  PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT,
).filter((schemaImport) => schemaImport.startsWith("caseLaw"));

export const PUBLIC_LAW_COLUMNS_BY_RELATION = {
  case_law_citations: [
    "id",
    "citing_decision_id",
    "cited_decision_id",
    "citation_text",
    "kind",
    "section_index",
    "polarity",
  ],
  case_law_corpus_index_projections: [
    "generation",
    "decision_id",
    "index_id",
    "indexed_hash",
    "pending_action",
  ],
  case_law_decision_identifiers: [
    "decision_id",
    "type",
    "value",
    "normalized_value",
    "created_at",
  ],
  case_law_decisions: [
    "id",
    "source_id",
    "case_number",
    "slug",
    "ecli",
    "court",
    "country",
    "language",
    "language_group_key",
    "decision_date",
    "decision_type",
    "fulltext",
    "sections",
    "document_ast",
    "analysis",
    "source_url",
    "document_url",
    "metadata",
    "redacted_at",
    "citation_authority",
    "citation_count",
    "text_s3_key",
    "ast_s3_key",
    "content_hash",
    "indexed_hash",
    "created_at",
    "updated_at",
  ],
  case_law_provision_citations: [
    "decision_id",
    "jurisdiction",
    "work_identifier",
    "work_number",
    "work_year",
    "work_collection",
    "work_eli",
    "unit",
    "section",
    "section_suffix",
    "subsection",
    "letter",
    "point",
    "sentence",
    "open_ended",
    "anchor",
    "version_valid_from",
    "decision_date",
    "sentence_text",
    "span_start",
    "span_end",
    "work_source",
    "confidence",
  ],
  case_law_sources: ["id", "name", "adapter_key", "descriptor"],
  corpus_index_generations: [
    "family",
    "generation",
    "cluster",
    "manifest_digest",
    "status",
  ],
  legislation_documents: [
    "id",
    "source_id",
    "eli",
    "title",
    "country",
    "language",
    "document_type",
    "status",
    "effective_date",
    "version_valid_from",
    "version_valid_to",
    "fulltext",
    "sections",
    "document_ast",
    "source_url",
    "document_url",
    "citation_authority",
    "text_s3_key",
    "ast_s3_key",
    "content_hash",
    "indexed_hash",
    "created_at",
    "updated_at",
  ],
  legislation_sources: ["id", "descriptor"],
} as const satisfies Record<PublicLawRelation, readonly string[]>;

/**
 * The v0.7.22 reader contract retained during the bounded rollout window.
 * Remove these constants with `stella_caselaw_reader` after that release can
 * no longer be deployed or used for rollback.
 */
export const ROLLOUT_CASE_LAW_WHOLE_RELATIONS = [
  "case_law_citations",
  "case_law_corpus_index_projections",
  "case_law_decisions",
  "case_law_provision_citations",
] as const;
export const ROLLOUT_CASE_LAW_SOURCE_RELATION = "case_law_sources";
export const ROLLOUT_CASE_LAW_SOURCE_COLUMNS = [
  "id",
  "name",
  "adapter_key",
  "descriptor",
] as const;
export const ROLLOUT_CASE_LAW_RELATIONS = [
  ...ROLLOUT_CASE_LAW_WHOLE_RELATIONS,
  ROLLOUT_CASE_LAW_SOURCE_RELATION,
] as const;
