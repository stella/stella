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
  caseLawDecisionIdentifiers: "case_law_decision_identifiers",
  caseLawDecisions: "case_law_decisions",
  caseLawProvisionCitations: "case_law_provision_citations",
  caseLawStatuteCitationCounts: "case_law_statute_citation_counts",
  caseLawStatuteCitationCountState: "case_law_statute_citation_count_state",
  caseLawSources: "case_law_sources",
  corpusIndexGenerations: "corpus_index_generations",
  corpusIndexProjectionStates: "corpus_index_projection_states",
  legislationDocuments: "legislation_documents",
  legislationSources: "legislation_sources",
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

/**
 * Each column declares how this release relates to its grant:
 *
 * - `required`: this release reads the column, so a role that cannot read it
 *   cannot serve. A missing grant fails the attestation.
 * - `permitted`: the grant exists but this release does not read it. A missing
 *   grant still serves, and holding the grant is not over-privilege.
 *
 * Anything readable beyond required plus permitted is over-privilege and fails
 * the attestation either way.
 *
 * Staging rule: the release whose migration grants a column lists it
 * `permitted`, and the release that starts reading it flips it to `required`.
 * Granting and reading in one release stays a single `required` entry. Give a
 * grant up in the reverse order: drop the read and the column to `permitted`
 * first, revoke in a later release. Either way both releases boot while the
 * migration and the code are one step apart.
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
  case_law_decision_identifiers: {
    decision_id: "required",
    type: "required",
    value: "required",
    normalized_value: "required",
    created_at: "required",
  },
  case_law_decisions: {
    id: "required",
    source_id: "required",
    case_number: "required",
    slug: "required",
    ecli: "required",
    citation_key: "required",
    court: "required",
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
    version_valid_from: "required",
    decision_date: "required",
    sentence_text: "required",
    span_start: "required",
    span_end: "required",
    work_source: "required",
    confidence: "required",
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
  case_law_sources: {
    id: "required",
    name: "required",
    adapter_key: "required",
    descriptor: "required",
  },
  corpus_index_generations: {
    family: "required",
    generation: "required",
    cluster: "required",
    manifest_digest: "required",
    status: "required",
  },
  // Exactly what deciding "this generation holds this decision now" reads.
  // The applied revision, the work schedule and the failure detail are
  // operator state and stay on the owning service side.
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
    applied_fingerprint: "required",
    applied_index_id: "required",
  },
  legislation_documents: {
    id: "required",
    source_id: "required",
    eli: "required",
    title: "required",
    country: "required",
    language: "required",
    document_type: "required",
    status: "required",
    effective_date: "required",
    version_valid_from: "required",
    version_valid_to: "required",
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
  legislation_sources: {
    id: "required",
    descriptor: "required",
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
 * the reader role may hold is here; migrations grant exactly this set, and the
 * `required` subset is what a release cannot serve without.
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
