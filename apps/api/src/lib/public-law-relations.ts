/**
 * Exact PostgreSQL columns required or permitted for the public-law reader role.
 *
 * Every relation is column-restricted. Operational cursors, source config,
 * raw publisher payloads, ingestion leases and index-repair state stay on the
 * owning service side. The runtime attestation and migration tests derive
 * from this map, so adding a field requires one explicit public-data decision.
 */
export const PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT = {
  caseLawCitations: "case_law_citations",
  caseLawCorpusTombstones: "case_law_corpus_tombstones",
  caseLawCourtDirectoryRanks: "case_law_court_directory_ranks",
  caseLawCourtWeights: "case_law_court_weights",
  caseLawDecisionAliases: "case_law_decision_aliases",
  caseLawDecisionIdentifiers: "case_law_decision_identifiers",
  caseLawDecisionJudges: "case_law_decision_judges",
  caseLawDecisions: "case_law_decisions",
  caseLawBrowseFacetCounts: "case_law_browse_facet_counts",
  caseLawFtsConfigs: "case_law_fts_configs",
  caseLawJudges: "case_law_judges",
  caseLawProvisionCitations: "case_law_provision_citations",
  caseLawProvisionExtractionRevisions:
    "case_law_provision_extraction_revisions",
  caseLawProvisionExtractionRevisionsRegistry:
    "case_law_provision_extraction_revisions_registry",
  caseLawProvisionExtractions: "case_law_provision_extractions",
  caseLawSearchDocuments: "case_law_search_documents",
  caseLawSitemapShards: "case_law_sitemap_shards",
  caseLawSourceArrivals: "case_law_source_arrivals",
  caseLawStatuteCitationCounts: "case_law_statute_citation_counts",
  caseLawStatuteCitationCountState: "case_law_statute_citation_count_state",
  caseLawSources: "case_law_sources",
  corpusIndexGenerations: "corpus_index_generations",
  corpusIndexGroupEnrollments: "corpus_index_group_enrollments",
  corpusIndexProjectionIntents: "corpus_index_projection_intents",
  corpusIndexProjectionStates: "corpus_index_projection_states",
  legislationDocuments: "legislation_documents",
  legislationFacetCounts: "legislation_facet_counts",
  legislationSearchDocuments: "legislation_search_documents",
  legislationSources: "legislation_sources",
  legislationWorkNames: "legislation_work_names",
  statuteSitemapShards: "statute_sitemap_shards",
} as const;

export type PublicLawRelation =
  (typeof PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT)[keyof typeof PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT];

export const PUBLIC_CASE_LAW_SCHEMA_IMPORTS = Object.keys(
  PUBLIC_LAW_RELATION_BY_SCHEMA_IMPORT,
).filter((schemaImport) => schemaImport.startsWith("caseLaw"));

/** How this release relates to a column's grant. */
export type PublicLawColumnGrant = "required" | "permitted";

export type PublicLawColumnGrantsByRelation = Readonly<
  Record<string, Readonly<Record<string, PublicLawColumnGrant>>>
>;

const PROVISION_LINK_STATUS_GRANT = "permitted";

/** Columns the provision link status capability requires after its grants land. */
export const PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION = {
  case_law_provision_citations: {
    span_role: PROVISION_LINK_STATUS_GRANT,
    print_piece_id: PROVISION_LINK_STATUS_GRANT,
    print_start: PROVISION_LINK_STATUS_GRANT,
    print_end: PROVISION_LINK_STATUS_GRANT,
    print_text: PROVISION_LINK_STATUS_GRANT,
    name_piece_id: PROVISION_LINK_STATUS_GRANT,
    name_start: PROVISION_LINK_STATUS_GRANT,
    name_end: PROVISION_LINK_STATUS_GRANT,
    name_text: PROVISION_LINK_STATUS_GRANT,
    selection: PROVISION_LINK_STATUS_GRANT,
    printed_work_identifier: PROVISION_LINK_STATUS_GRANT,
    target_document_id: PROVISION_LINK_STATUS_GRANT,
    target_status: PROVISION_LINK_STATUS_GRANT,
  },
  case_law_provision_extraction_revisions: {
    jurisdiction: PROVISION_LINK_STATUS_GRANT,
    min_current_revision: PROVISION_LINK_STATUS_GRANT,
  },
  case_law_provision_extraction_revisions_registry: {
    jurisdiction: PROVISION_LINK_STATUS_GRANT,
    revision: PROVISION_LINK_STATUS_GRANT,
  },
  case_law_provision_extractions: {
    decision_id: PROVISION_LINK_STATUS_GRANT,
    desired_input_digest: PROVISION_LINK_STATUS_GRANT,
    work_status: PROVISION_LINK_STATUS_GRANT,
    generation: PROVISION_LINK_STATUS_GRANT,
    outcome: PROVISION_LINK_STATUS_GRANT,
    published_input_digest: PROVISION_LINK_STATUS_GRANT,
    published_jurisdiction: PROVISION_LINK_STATUS_GRANT,
    published_revision: PROVISION_LINK_STATUS_GRANT,
    published_projection_digest: PROVISION_LINK_STATUS_GRANT,
    payload_class: PROVISION_LINK_STATUS_GRANT,
    payload_class_input_digest: PROVISION_LINK_STATUS_GRANT,
  },
} as const satisfies PublicLawColumnGrantsByRelation;

/**
 * Each column declares how this release relates to its grant:
 *
 * - `required`: this release reads the column, so a role that cannot read it
 *   cannot serve. A missing grant fails the attestation.
 * - `permitted`: this release can use it when granted, but also serves
 *   without it. The role may hold the grant or not.
 *
 * The attestation holds the role to `required ⊆ grants ⊆ required ∪
 * permitted`, column by column; a table-wide grant is refused outright.
 *
 * Both bounds come from the running release's own map, and a release cannot
 * know a column a later map adds: it reads any grant outside its map as
 * over-privilege. The provision link status columns are `permitted` during
 * the expand phase. The read checks for the complete capability grant and
 * falls back until a follow-up grant migration lands. Deploy this expansion
 * release before applying that migration, so running readers accept it.
 * Giving a grant up runs the other way: drop the read and mark the column
 * `permitted` first, revoke in a later release, so both releases serve while
 * the two steps are apart.
 */
export const PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION = {
  case_law_citations: {
    id: "required",
    citing_decision_id: "required",
    cited_decision_id: "required",
    citation_text: "required",
    kind: "required",
    section_index: "required",
    polarity: "required",
  },
  // The denial list a corpus read consults before it serves a packed
  // member. The address is the whole of the question; who was erased, why and
  // which pack owes the rewrite stay on the owning service side.
  case_law_corpus_tombstones: {
    location: "required",
  },
  // The keyed rank lookup in public case-law search and citation scoring.
  case_law_court_directory_ranks: {
    country: "required",
    court_id: "required",
    tier: "required",
    weight: "required",
  },
  // The court registry the public ranking and court chips read. The row id
  // and its creation time are bookkeeping.
  case_law_court_weights: {
    country: "required",
    court_pattern: "required",
    tier: "required",
    tier_label: "required",
    weight: "required",
  },
  // Accept the future reader grant before a later release grants and reads it.
  case_law_decision_aliases: {
    retired_decision_id: "permitted",
    canonical_decision_id: "permitted",
  },
  case_law_decision_identifiers: {
    decision_id: "required",
    type: "required",
    value: "required",
    normalized_value: "required",
    created_at: "required",
  },
  // The judges a decision names. `name_key` is the roster join and is not
  // read by the projection, which renders the printed name.
  case_law_decision_judges: {
    decision_id: "required",
    judge_id: "required",
    name_as_printed: "required",
    name_key: "permitted",
    role: "required",
    position: "required",
  },
  case_law_decisions: {
    id: "required",
    source_id: "required",
    case_number: "required",
    case_number_type: "required",
    slug: "required",
    ecli: "required",
    citation_key: "required",
    // Granted a release after the column (expand first); the read probes
    // for the grant and falls back to the spellings without it.
    docket_family_key: "permitted",
    court: "required",
    court_id: "required",
    country: "required",
    language: "required",
    language_group_key: "required",
    decision_date: "required",
    decision_type: "required",
    fulltext: "required",
    sections: "required",
    document_ast: "required",
    analysis: "required",
    source_url: "required",
    document_url: "required",
    metadata: "required",
    redacted_at: "required",
    citation_authority: "required",
    citation_count: "required",
    text_s3_key: "required",
    ast_s3_key: "required",
    content_hash: "required",
    // Granted, and no longer read: the column is dropped a release from now.
    indexed_hash: "permitted",
    created_at: "required",
    updated_at: "required",
  },
  // The text-search configuration a language's query is parsed with. It is
  // read from the database whose search documents it has to match.
  case_law_fts_configs: {
    language: "required",
    regconfig: "required",
    use_unaccent: "required",
  },
  // Only what a portrait is served from. The roster's own fields (name, term
  // dates, where the row was read) are not part of a decision's projection.
  case_law_judges: {
    id: "required",
    portrait_s3_key: "required",
    portrait_attribution: "required",
    portrait_content_type: "required",
  },
  case_law_provision_citations: {
    decision_id: "required",
    jurisdiction: "required",
    work_identifier: "required",
    work_number: "required",
    work_year: "required",
    work_collection: "required",
    work_eli: "required",
    unit: "required",
    section: "required",
    section_suffix: "required",
    subsection: "required",
    letter: "required",
    point: "required",
    sentence: "required",
    open_ended: "required",
    anchor: "required",
    applied_version_basis: "required",
    applied_version_date: "required",
    applied_version_date_relation: "required",
    applied_version_amendment_work_identifier: "required",
    applied_version_expression_date: "required",
    applied_version_expression_eli: "required",
    version_evidence_start: "required",
    version_evidence_end: "required",
    version_evidence_kind: "required",
    version_valid_from: "required",
    decision_date: "required",
    sentence_text: "required",
    span_start: "required",
    span_end: "required",
    work_source: "required",
    confidence: "required",
    ...PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION.case_law_provision_citations,
  },
  case_law_provision_extraction_revisions: {
    ...PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION.case_law_provision_extraction_revisions,
  },
  case_law_provision_extraction_revisions_registry: {
    ...PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION.case_law_provision_extraction_revisions_registry,
  },
  case_law_provision_extractions: {
    ...PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION.case_law_provision_extractions,
  },
  // What a search matches, ranks and cuts its headline from. The stored
  // title, the preview generation and the refresh time serve the indexer.
  case_law_search_documents: {
    decision_id: "required",
    language: "required",
    regconfig: "required",
    tsv: "required",
    searchable_text: "required",
  },
  // The shards the public sitemap index lists. The count is how the refresh
  // splits a month, not what the index states.
  case_law_sitemap_shards: {
    country: "required",
    year: "required",
    month: "required",
    bucket: "required",
    last_modified_at: "required",
  },
  case_law_source_arrivals: {
    source_id: "required",
    added_last_week: "required",
    counted_at: "required",
  },
  legislation_facet_counts: {
    country: "required",
    source_id: "required",
    document_type: "required",
    works: "required",
  },
  case_law_browse_facet_counts: {
    kind: "required",
    country: "required",
    source_id: "required",
    value: "required",
    total: "required",
  },
  case_law_statute_citation_counts: {
    source_id: "required",
    jurisdiction: "required",
    work_eli: "required",
    target_type: "required",
    anchor: "required",
    decision_count: "required",
    updated_at: "required",
  },
  case_law_statute_citation_count_state: {
    key: "required",
    status: "required",
    updated_at: "required",
  },
  // The feed's public identity, its redistribution terms, and the coverage
  // bookkeeping the public coverage page states. The cursor, the lease, the
  // observation orders and the source's own configuration stay on the
  // ingestion side: they are how the crawl works, not what the corpus holds.
  case_law_sources: {
    id: "required",
    name: "required",
    adapter_key: "required",
    descriptor: "required",
    enabled: "required",
    last_sync_at: "required",
    reported_total: "required",
    reported_total_as_of: "required",
    reported_total_origin: "required",
    stored_total: "required",
    stored_total_as_of: "required",
  },
  corpus_index_generations: {
    family: "required",
    generation: "required",
    cluster: "required",
    manifest_digest: "required",
    status: "required",
  },
  // Whether a serving group under its own contract is ready to be read: the
  // bound digest and the readiness. The physical id and the timestamps are
  // operator bookkeeping.
  corpus_index_group_enrollments: {
    family: "required",
    generation: "required",
    index_group: "required",
    effective_digest: "required",
    provisioning_status: "required",
  },
  // Exactly what deciding "this generation holds this decision now" reads.
  // The revision joins its physical passage count; work schedules and failure
  // details stay on the owning service side.
  corpus_index_projection_states: {
    family: "required",
    generation: "required",
    entity_id: "required",
    desired_action: "required",
    desired_epoch: "required",
    desired_fingerprint: "required",
    desired_index_id: "required",
    applied_action: "required",
    applied_epoch: "required",
    applied_revision: "required",
    applied_fingerprint: "required",
    applied_index_id: "required",
  },
  // Exact physical count of the applied revision, needed for pagination exclusions.
  corpus_index_projection_intents: {
    id: "required",
    expected_document_count: "required",
  },
  legislation_documents: {
    id: "required",
    source_id: "required",
    eli: "required",
    slug: "required",
    title: "required",
    country: "required",
    language: "required",
    document_type: "required",
    status: "required",
    effective_date: "required",
    version_valid_from: "required",
    version_valid_to: "required",
    expression_kind: "required",
    window_disposition: "required",
    window_disposition_basis: "required",
    fulltext: "required",
    sections: "required",
    document_ast: "required",
    source_url: "required",
    document_url: "required",
    citation_authority: "required",
    text_s3_key: "required",
    ast_s3_key: "required",
    content_hash: "required",
    // Granted, and no longer read: the column is dropped a release from now.
    indexed_hash: "permitted",
    created_at: "required",
    updated_at: "required",
  },
  // The legislation twin of the case-law search document. `retry_after` is
  // the eligibility a search filters on: a document whose indexing is still
  // being retried is not offered yet.
  legislation_search_documents: {
    document_id: "required",
    language: "required",
    regconfig: "required",
    tsv: "required",
    searchable_text: "required",
    retry_after: "required",
  },
  statute_sitemap_shards: {
    country: "required",
    bucket: "required",
    lastmod: "required",
    total: "required",
  },
  legislation_sources: {
    id: "required",
    descriptor: "required",
  },
  // The name lookup a legislation search places named acts first by: the
  // match keys and what they point at, not the names' text.
  legislation_work_names: {
    document_id: "required",
    country: "required",
    derivation: "required",
    cited_key: "required",
    match_key: "required",
  },
} as const satisfies Record<
  PublicLawRelation,
  Readonly<Record<string, PublicLawColumnGrant>>
>;

export type PublicLawColumnPair = {
  relation: string;
  column: string;
  grant: PublicLawColumnGrant;
};

/**
 * Flatten a grant map into one entry per column, tag included. Every column
 * the reader role may hold is here; migrations grant within this set, and the
 * `required` subset is what they must grant and a release cannot serve
 * without.
 */
export const publicLawColumnPairs = (
  grants: PublicLawColumnGrantsByRelation,
): PublicLawColumnPair[] =>
  Object.entries(grants).flatMap(([relation, columns]) =>
    Object.entries(columns).map(([column, grant]) => ({
      relation,
      column,
      grant,
    })),
  );

/**
 * The v0.7.22 reader contract retained during the bounded rollout window.
 * Remove these constants with `stella_caselaw_reader` after that release can
 * no longer be deployed or used for rollback.
 */
export const ROLLOUT_CASE_LAW_WHOLE_RELATIONS = [
  "case_law_citations",
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
