import {
  globalCaseLawPolicies,
  isNotNull,
  isNull,
  jsonb,
  p,
  pUuid,
  safeUuid,
  safeWorkspaceId,
  sql,
  tsvector,
  user,
  wsPolicies,
} from "./common";
import type {
  CorpusSourceDescriptor,
  DecisionSection,
  DocumentAst,
  EmptyAst,
  PersistedDecisionAnalysis,
} from "./common";
import { workspaces } from "./contacts";

export const caseLawSources = p.pgTable(
  "case_law_sources",
  {
    id: pUuid<"caseLawSource">().primaryKey(),
    adapterKey: p.varchar("adapter_key", { length: 64 }).notNull(),
    name: p.varchar({ length: 256 }).notNull(),
    enabled: p.boolean().default(true).notNull(),
    syncCursor: p.text("sync_cursor"),
    lastSyncAt: p.timestamp("last_sync_at"),
    config: jsonb().$type<Record<string, unknown>>().default({}),
    // License / redistribution terms. null = legacy source (public
    // court records, treated as redistributable); see corpus-source.ts.
    descriptor: jsonb().$type<CorpusSourceDescriptor>(),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
    updatedAt: p
      .timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.uniqueIndex("case_law_sources_adapter_key_idx").on(t.adapterKey),
    ...globalCaseLawPolicies(),
  ],
);

export const caseLawDecisions = p.pgTable(
  "case_law_decisions",
  {
    id: pUuid<"caseLawDecision">().primaryKey(),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "cascade" }),
    caseNumber: p.varchar("case_number", { length: 256 }).notNull(),
    slug: p.varchar({ length: 256 }),
    ecli: p.varchar({ length: 256 }),
    court: p.varchar({ length: 512 }).notNull(),
    country: p.varchar({ length: 3 }).notNull(),
    language: p.varchar({ length: 8 }).notNull(),
    languageGroupKey: p.varchar("language_group_key", {
      length: 512,
    }),
    decisionDate: p.date("decision_date"),
    decisionType: p.varchar("decision_type", { length: 128 }),
    fulltext: p.text(),
    sections: jsonb().$type<DecisionSection[]>(),
    documentAst: jsonb("document_ast").$type<DocumentAst | EmptyAst>(),
    /**
     * AI-generated structural analysis: hierarchical headings
     * with annotations anchored to paragraph ranges. Generated
     * on-demand on first open, persisted permanently.
     * null = not yet generated.
     */
    analysis: jsonb().$type<PersistedDecisionAnalysis>(),
    /**
     * Parser version that produced documentAst. Compared
     * against the adapter's current version on read; stale
     * ASTs are re-parsed lazily from sourceRaw in S3.
     */
    parserVersion: p.smallint("parser_version").default(0),
    /**
     * Raw source HTML/JSON from the court website, stored
     * verbatim for future re-parsing without re-downloading.
     * Compressed at the application level if needed.
     */
    sourceRaw: p.text("source_raw"),
    sourceRawS3Key: p.varchar("source_raw_s3_key", {
      length: 512,
    }),
    sourceRawContentType: p.varchar("source_raw_content_type", { length: 128 }),
    sourceUrl: p.varchar("source_url", { length: 2048 }),
    documentUrl: p.varchar("document_url", { length: 2048 }),
    metadata: jsonb().$type<Record<string, unknown>>().default({}),
    sourceHash: p.varchar("source_hash", { length: 64 }),
    /**
     * Materialized citation-authority ranking signal: the
     * ln(1 + weighted-citation-density) value that `citationScore()`
     * computes. Precomputed by the post-ingestion citation pass so
     * search reads it instead of recomputing the citation-graph
     * aggregate per query. Decays slowly with time; refreshed on a
     * schedule. `citationAuthorityComputedAt` tracks staleness.
     */
    citationAuthority: p
      .doublePrecision("citation_authority")
      .default(0)
      .notNull(),
    citationCount: p.integer("citation_count").default(0).notNull(),
    citationAuthorityComputedAt: p.timestamp("citation_authority_computed_at"),
    /**
     * Object-storage keys for the canonical corpus payloads. Populated
     * by the corpus-storage backfill / ingestion write when
     * CORPUS_STORAGE_ENABLED. Null = canonical text still lives only in
     * the `fulltext`/`sections`/`documentAst` columns (pre-migration).
     */
    textS3Key: p.varchar("text_s3_key", { length: 512 }),
    normalizedS3Key: p.varchar("normalized_s3_key", { length: 512 }),
    astS3Key: p.varchar("ast_s3_key", { length: 512 }),
    /**
     * Incremental-indexing / blue-green bookkeeping. `contentHash` is
     * the sha256 of the canonical payload (what S3 is keyed on);
     * `indexedHash` is the last hash pushed to the search projection,
     * so `indexedHash IS DISTINCT FROM contentHash` marks a stale row.
     * `indexedGeneration` is which generation (e.g. case_law_v1) the
     * row was last written into.
     */
    contentHash: p.varchar("content_hash", { length: 64 }),
    indexedHash: p.varchar("indexed_hash", { length: 64 }),
    indexedGeneration: p.varchar("indexed_generation", { length: 32 }),
    indexedAt: p.timestamp("indexed_at"),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
    updatedAt: p
      .timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p
      .uniqueIndex("case_law_decisions_source_case_lang_idx")
      .on(t.sourceId, t.caseNumber, t.language),
    p
      .uniqueIndex("case_law_decisions_slug_uidx")
      .on(t.slug)
      .where(isNotNull(t.slug)),
    p.index("case_law_decisions_case_number_idx").on(t.caseNumber),
    p.index("case_law_decisions_court_idx").on(t.court),
    p.index("case_law_decisions_country_idx").on(t.country),
    p.index("case_law_decisions_date_idx").on(t.decisionDate),
    p.index("case_law_decisions_ecli_idx").on(t.ecli).where(isNotNull(t.ecli)),
    p
      .index("case_law_decisions_lang_group_idx")
      .on(t.languageGroupKey)
      .where(isNotNull(t.languageGroupKey)),
    p.index("case_law_decisions_created_at_idx").on(t.createdAt),
    p
      .index("case_law_decisions_citation_authority_idx")
      .on(t.citationAuthority),
    // Supports the missing/stale scan the corpus index indexer loop runs
    // (mirrors backfillSearchIndex): rows whose indexedHash differs
    // from contentHash, or were never indexed.
    p.index("case_law_decisions_indexed_idx").on(t.indexedHash, t.contentHash),
    ...globalCaseLawPolicies(),
  ],
);

export const caseLawCitations = p.pgTable(
  "case_law_citations",
  {
    id: pUuid<"caseLawCitation">().primaryKey(),
    citingDecisionId: safeUuid<"caseLawDecision">("citing_decision_id")
      .notNull()
      .references(() => caseLawDecisions.id, { onDelete: "cascade" }),
    citedDecisionId: safeUuid<"caseLawDecision">(
      "cited_decision_id",
    ).references(() => caseLawDecisions.id, {
      onDelete: "set null",
    }),
    citationText: p.varchar("citation_text", { length: 512 }).notNull(),
    sectionIndex: p.integer("section_index"),
    polarity: p.varchar("polarity", { length: 16 }),
    polarityRuleId: safeUuid<"caseLawPolarityRule">(
      "polarity_rule_id",
    ).references(() => caseLawPolarityRules.id, {
      onDelete: "set null",
    }),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.index("case_law_citations_citing_idx").on(t.citingDecisionId),
    p
      .index("case_law_citations_cited_idx")
      .on(t.citedDecisionId)
      .where(isNotNull(t.citedDecisionId)),
    p
      .index("case_law_citations_polarity_null_idx")
      .on(t.polarity)
      .where(isNull(t.polarity)),
    p.check(
      "citations_polarity_values",
      sql`${t.polarity} IN ('positive','supportive','neutral','negative','unknown')`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

export const caseLawPolarityRules = p.pgTable(
  "case_law_polarity_rules",
  {
    id: pUuid<"caseLawPolarityRule">().primaryKey(),
    pattern: p.varchar("pattern", { length: 512 }).notNull(),
    polarity: p.varchar("polarity", { length: 16 }).notNull(),
    language: p.varchar("language", { length: 8 }).notNull(),
    source: p.varchar("source", { length: 16 }).notNull().default("manual"),
    confidence: p.doublePrecision("confidence").notNull().default(1),
    matchCount: p.integer("match_count").notNull().default(0),
    surfaceForms: jsonb("surface_forms").$type<string[]>().default([]),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
    updatedAt: p
      .timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.index("case_law_polarity_rules_lang_idx").on(t.language),
    p
      .uniqueIndex("case_law_polarity_rules_pattern_lang_idx")
      .on(t.pattern, t.language),
    p.check(
      "polarity_rules_polarity_values",
      sql`${t.polarity} IN ('positive','supportive','neutral','negative','unknown')`,
    ),
    p.check(
      "polarity_rules_source_values",
      sql`${t.source} IN ('manual','llm-proposed','llm-promoted')`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

// ---------------------------------------------------------------------------
// Case Law — Tenant-scoped tables
// ---------------------------------------------------------------------------

export const caseLawMatterLinks = p.pgTable(
  "case_law_matter_links",
  {
    id: pUuid<"caseLawMatterLink">().primaryKey(),
    decisionId: safeUuid<"caseLawDecision">("decision_id")
      .notNull()
      .references(() => caseLawDecisions.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    note: p.text(),
    linkedBy: p
      .text("linked_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .uniqueIndex("case_law_matter_links_decision_ws_idx")
      .on(t.decisionId, t.workspaceId),
    p.index("case_law_matter_links_workspace_idx").on(t.workspaceId),
    ...wsPolicies(),
  ],
);

// ---------------------------------------------------------------------------
// Case Law — Search index (global, no tenant column)
// ---------------------------------------------------------------------------

export const caseLawCourtWeights = p.pgTable(
  "case_law_court_weights",
  {
    id: pUuid<"caseLawCourtWeight">().primaryKey(),
    country: p.varchar({ length: 3 }).notNull(),
    courtPattern: p.varchar("court_pattern", { length: 512 }).notNull(),
    tier: p.integer().notNull(),
    tierLabel: p.varchar("tier_label", { length: 64 }).notNull(),
    weight: p.doublePrecision().notNull(),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .uniqueIndex("case_law_court_weights_country_pattern_idx")
      .on(t.country, t.courtPattern),
    p.index("case_law_court_weights_country_idx").on(t.country),
    ...globalCaseLawPolicies(),
  ],
);

export const caseLawFtsConfigs = p.pgTable(
  "case_law_fts_configs",
  {
    language: p.varchar({ length: 8 }).primaryKey(),
    regconfig: p.varchar({ length: 64 }).notNull(),
    useUnaccent: p.boolean("use_unaccent").notNull().default(true),
  },
  () => [...globalCaseLawPolicies()],
);

export const caseLawSearchDocuments = p.pgTable(
  "case_law_search_documents",
  {
    decisionId: safeUuid<"caseLawDecision">("decision_id")
      .primaryKey()
      .references(() => caseLawDecisions.id, {
        onDelete: "cascade",
      }),
    title: p.text().notNull().default(""),
    searchableText: p.text("searchable_text").notNull().default(""),
    language: p.varchar("language", { length: 10 }),
    regconfig: p.varchar({ length: 64 }).notNull().default("simple"),
    tsv: tsvector(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("case_law_search_docs_tsv_idx").using("gin", table.tsv),
    ...globalCaseLawPolicies(),
  ],
);

// ---------------------------------------------------------------------------
// Case Law — Ingestion observability
// ---------------------------------------------------------------------------

export const caseLawIngestionEvents = p.pgTable(
  "case_law_ingestion_events",
  {
    id: pUuid<"caseLawIngestionEvent">().primaryKey(),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "cascade" }),
    status: p.varchar({ length: 16 }).notNull().$type<"completed" | "failed">(),
    inserted: p.integer().notNull().default(0),
    skipped: p.integer().notNull().default(0),
    searchVectorFailures: p
      .integer("search_vector_failures")
      .notNull()
      .default(0),
    pagesProcessed: p.integer("pages_processed").notNull().default(0),
    cursorBefore: p.text("cursor_before"),
    cursorAfter: p.text("cursor_after"),
    durationMs: p.integer("duration_ms").notNull(),
    errorMessage: p.varchar("error_message", { length: 2048 }),
    startedAt: p.timestamp("started_at").notNull(),
    finishedAt: p.timestamp("finished_at").defaultNow().notNull(),
  },
  (t) => [
    p.index("case_law_ingestion_events_source_idx").on(t.sourceId),
    p.index("case_law_ingestion_events_finished_idx").on(t.finishedAt),
    ...globalCaseLawPolicies(),
  ],
);

export const caseLawIngestionFailures = p.pgTable(
  "case_law_ingestion_failures",
  {
    id: pUuid<"caseLawIngestionFailure">().primaryKey(),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "cascade" }),
    caseNumber: p.varchar("case_number", { length: 256 }).notNull(),
    language: p.varchar({ length: 8 }),
    errorType: p.varchar("error_type", { length: 128 }).notNull(),
    errorMessage: p.varchar("error_message", { length: 2048 }).notNull(),
    cursor: p.text(),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.index("case_law_ingestion_failures_source_idx").on(t.sourceId),
    p.index("case_law_ingestion_failures_error_type_idx").on(t.errorType),
    p.index("case_law_ingestion_failures_created_idx").on(t.createdAt),
    ...globalCaseLawPolicies(),
  ],
);

/**
 * Append-only audit trail for search-index mutations across the
 * object-store + corpus index boundary. Because canonical text and index
 * state move out of the DB transaction log, this is the record of what
 * entered, left, or was redacted from the corpus. `decisionId` is null
 * for batch/full-rebuild rows.
 */
export const caseLawIndexJobs = p.pgTable(
  "case_law_index_jobs",
  {
    id: pUuid<"caseLawIndexJob">().primaryKey(),
    decisionId: safeUuid<"caseLawDecision">("decision_id").references(
      () => caseLawDecisions.id,
      { onDelete: "cascade" },
    ),
    generation: p.varchar({ length: 32 }).notNull(),
    operation: p
      .varchar({ length: 16 })
      .notNull()
      .$type<"index" | "delete" | "redact" | "rebuild">(),
    status: p.varchar({ length: 16 }).notNull().$type<"succeeded" | "failed">(),
    contentHash: p.varchar("content_hash", { length: 64 }),
    errorMessage: p.varchar("error_message", { length: 2048 }),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.index("case_law_index_jobs_decision_idx").on(t.decisionId),
    p.index("case_law_index_jobs_created_idx").on(t.createdAt),
    p.check(
      "case_law_index_jobs_operation_values",
      sql`${t.operation} IN ('index','delete','redact','rebuild')`,
    ),
    p.check(
      "case_law_index_jobs_status_values",
      sql`${t.status} IN ('succeeded','failed')`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

// ---------------------------------------------------------------------------
// Legislation / statutes — global corpus (mirrors case law). Point-in-time
// temporal model: each row is a consolidated expression of a work (`eli`),
// valid over [version_valid_from, version_valid_to); version_valid_to NULL
// = the current consolidation. status = current | historical | repealed |
// draft. Shares the object-storage + corpus index substrate via the
// `legislation` corpus family.
// ---------------------------------------------------------------------------
