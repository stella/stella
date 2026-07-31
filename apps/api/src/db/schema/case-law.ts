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
  timestamptz,
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
    lastSyncAt: timestamptz("last_sync_at"),
    config: jsonb().$type<Record<string, unknown>>().default({}),
    // License / redistribution terms. null = legacy source (public
    // court records, treated as redistributable); see corpus-source.ts.
    descriptor: jsonb().$type<CorpusSourceDescriptor>(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
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
    /**
     * `caseNumber` under `bareCitationKey`. A citation's text canonicalizes
     * to the same key, so resolution is an indexed equality join rather than
     * a scan. Null when the case number does not canonicalize, which keeps
     * unresolvable rows out of the join instead of matching on "".
     */
    citationKey: p.varchar("citation_key", { length: 128 }),
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
    /**
     * The publisher's own identifier for this document, as the source states
     * it. This is what identifies a decision.
     *
     * A case number cannot: courts number their dockets per court, so one
     * source covering many courts issues the same number many times over
     * (`0T/42/2019` exists at most Slovak district courts). Keying on it
     * makes two unrelated decisions the same row. The publisher's id is
     * unique across the whole source by construction.
     *
     * Null only for sources that expose no such id; those keep the older
     * case-number key, which is sound for a source holding one court.
     */
    sourceDocumentId: p.varchar("source_document_id", { length: 256 }),
    /**
     * Sheet number within the court file (číslo listu), where the source
     * appends one to the docket: `11 C 153/2025-28` is sheet 28 of case
     * `11 C 153/2025`.
     *
     * It is not part of the case reference and no one cites it, so it is kept
     * out of `caseNumber`, which would otherwise fragment one case into a row
     * per sheet and match no citation. Null wherever the source appends
     * nothing.
     */
    sheetNumber: p.varchar("sheet_number", { length: 32 }),
    /**
     * Bookkeeping for sources that ingest metadata first and fetch the
     * document later (see `ingestion/sk-document-backfill.ts`).
     * `documentFetchRequestedAt` is the first read that asked for the
     * document and orders the queue's priority tier; it is set once, so
     * repeat readers do not push a decision back. `documentFetchAttempts`
     * counts fetch attempts from either path, so a document that keeps
     * failing stops holding the front of the queue.
     * `documentFetchAttemptedAt` is when the current attempt started: it
     * is the durable claim that keeps a scheduler run and a read on
     * another replica from downloading the same document at once, and it
     * expires so a worker that died mid-fetch does not strand the row.
     */
    documentFetchRequestedAt: timestamptz("document_fetch_requested_at"),
    documentFetchAttemptedAt: timestamptz("document_fetch_attempted_at"),
    documentFetchAttempts: p
      .integer("document_fetch_attempts")
      .default(0)
      .notNull(),
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
    citationAuthorityComputedAt: timestamptz("citation_authority_computed_at"),
    /**
     * Object-storage keys for the canonical corpus payloads. Populated
     * by the corpus-storage backfill / ingestion write whenever
     * CORPUS_STORAGE_MODE is not "off". Null = canonical text still lives
     * only in the `fulltext`/`sections`/`documentAst` columns
     * (pre-migration). Under CORPUS_STORAGE_MODE=canonical the inverse
     * holds: these are set and those columns are NULL.
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
    indexedAt: timestamptz("indexed_at"),
    createdAt: timestamptz("created_at")
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Identity, in two halves that together cover every row exactly once.
    // Where the publisher states an id, that is the key. Where it does not,
    // the case number still serves, because such a source holds one court
    // and its numbering is unique within it.
    p
      .uniqueIndex("case_law_decisions_source_document_idx")
      .on(t.sourceId, t.sourceDocumentId)
      .where(isNotNull(t.sourceDocumentId)),
    p
      .uniqueIndex("case_law_decisions_source_case_lang_null_idx")
      .on(t.sourceId, t.caseNumber, t.language)
      .where(isNull(t.sourceDocumentId)),
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
      .index("case_law_decisions_corpus_generation_cursor_idx")
      .on(t.createdAt, t.id),
    p
      .index("case_law_decisions_updated_id_idx")
      .on(t.updatedAt.desc(), t.id.desc()),
    p
      .index("case_law_decisions_citation_authority_idx")
      .on(t.citationAuthority),
    // Supports the missing/stale scan the corpus index indexer loop runs
    // (mirrors backfillSearchIndex): rows whose indexedHash differs
    // from contentHash, or were never indexed.
    p.index("case_law_decisions_indexed_idx").on(t.indexedHash, t.contentHash),
    // Pending set for the corpus indexer's missing scan. Partial on the
    // un-indexed predicate so the index stays proportional to the remaining
    // work, not the corpus: without it the scan's cost grows with every row
    // already marked, which starved bulk builds and the daemon loop alike.
    p
      .index("case_law_decisions_corpus_pending_idx")
      .on(t.id)
      .where(
        sql`${t.contentHash} is not null and ${t.indexedGeneration} is null`,
      ),
    p
      .index("case_law_decisions_corpus_hash_pending_idx")
      .on(t.id)
      .where(sql`${t.contentHash} is not null and ${t.indexedHash} is null`),
    p
      .index("case_law_decisions_citation_key_idx")
      .on(t.citationKey)
      .where(isNotNull(t.citationKey)),
    // Deferred-document queue, priority tier: decisions a reader asked
    // for, oldest request first. Partial on the pending predicate, so
    // the index stays proportional to the queue, not to the corpus.
    p
      .index("case_law_decisions_document_demand_idx")
      .on(t.documentFetchRequestedAt, t.id)
      .where(
        sql`${t.fulltext} is null and ${t.documentUrl} is not null and ${t.documentFetchRequestedAt} is not null`,
      ),
    // Deferred-document queue, remaining tier: least-tried first, then
    // newest decisions, per source. Matches the loader's ORDER BY so the
    // head of the queue is a bounded index range scan rather than a sort
    // over the backlog.
    p
      .index("case_law_decisions_document_pending_idx")
      .on(
        t.sourceId,
        t.documentFetchAttempts,
        t.decisionDate.desc().nullsLast(),
        t.id,
      )
      .where(sql`${t.fulltext} is null and ${t.documentUrl} is not null`),
    ...globalCaseLawPolicies(),
  ],
);

/**
 * Per-slice crawl coverage: what a court said a slice contains against what
 * the crawl stored for it.
 *
 * Without this, a partial crawl is indistinguishable from a quiet day, and
 * the loss is silent and permanent — a forward-only cursor never revisits.
 * A row per slice makes the shortfall queryable, so re-crawls target the
 * slices that are actually short instead of re-running whole years.
 */
export const caseLawCoverageSlices = p.pgTable(
  "case_law_coverage_slices",
  {
    id: pUuid<"caseLawCoverageSlice">().primaryKey(),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "cascade" }),
    /** The crawl slice, e.g. an ISO day for date-cursor adapters. */
    slice: p.varchar({ length: 64 }).notNull(),
    /** The source's own count for this slice. */
    reported: p.integer().notNull(),
    /** What the crawl produced for it. */
    collected: p.integer().notNull(),
    checkedAt: timestamptz("checked_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .uniqueIndex("case_law_coverage_slices_source_slice_idx")
      .on(t.sourceId, t.slice),
    // The reconciliation pass reads only the short slices, so the index
    // covers that arm and shrinks as gaps close.
    p
      .index("case_law_coverage_slices_short_idx")
      .on(t.sourceId, t.slice)
      .where(sql`${t.collected} < ${t.reported}`),
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
    /** `citationText` under `bareCitationKey`; joins to a decision's own key. */
    citationKey: p.varchar("citation_key", { length: 128 }),
    /**
     * Whether this citation invokes authority or names the case's own
     * procedural history. Only `precedent` belongs in the citation graph:
     * the judgment under review is not an endorsement of it.
     *
     * Deliberately a plain string rather than a column-level union: the
     * union re-instantiates this table's type everywhere it is referenced,
     * including through the API surface into the web type graph, which
     * costs more than it buys. `citations_kind_values` keeps the database
     * honest and `CitationKind` types the write path.
     */
    kind: p.varchar({ length: 16 }).default("precedent").notNull(),
    sectionIndex: p.integer("section_index"),
    polarity: p.varchar("polarity", { length: 16 }),
    polarityRuleId: safeUuid<"caseLawPolarityRule">(
      "polarity_rule_id",
    ).references(() => caseLawPolarityRules.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
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
    p
      .index("case_law_citations_unresolved_key_idx")
      .on(t.citationKey)
      .where(
        sql`${t.citedDecisionId} is null and ${t.citationKey} is not null`,
      ),
    p.check(
      "citations_polarity_values",
      sql`${t.polarity} IN ('positive','supportive','neutral','negative','unknown')`,
    ),
    p.check(
      "citations_kind_values",
      sql`${t.kind} IN ('precedent','procedural')`,
    ),
    // Authority reads precedent only, so the index covers that arm.
    p
      .index("case_law_citations_precedent_cited_idx")
      .on(t.citedDecisionId)
      .where(sql`${t.kind} = 'precedent' AND ${t.citedDecisionId} IS NOT NULL`),
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
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
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
    createdAt: timestamptz("created_at").defaultNow().notNull(),
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
    createdAt: timestamptz("created_at").defaultNow().notNull(),
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
    previewGeneration: p.uuid("preview_generation"),
    tsv: tsvector(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("case_law_search_docs_tsv_idx").using("gin", table.tsv),
    ...globalCaseLawPolicies(),
  ],
);

export const caseLawSearchDocumentPreviewPassages = p.pgTable(
  "case_law_search_document_preview_passages",
  {
    decisionId: safeUuid<"caseLawDecision">("decision_id")
      .notNull()
      .references(() => caseLawSearchDocuments.decisionId, {
        onDelete: "cascade",
      }),
    generation: p.uuid().notNull(),
    ordinal: p.integer().notNull(),
    content: p.text().notNull(),
    tsv: tsvector().notNull(),
  },
  (table) => [
    p.primaryKey({
      columns: [table.decisionId, table.generation, table.ordinal],
      name: "case_law_search_document_preview_passages_pk",
    }),
    p
      .index("case_law_preview_passages_lookup_idx")
      .on(table.decisionId, table.generation, table.ordinal),
    p.index("case_law_preview_passages_tsv_idx").using("gin", table.tsv),
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
    startedAt: timestamptz("started_at").notNull(),
    finishedAt: timestamptz("finished_at").defaultNow().notNull(),
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
    createdAt: timestamptz("created_at").defaultNow().notNull(),
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
    createdAt: timestamptz("created_at").defaultNow().notNull(),
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

export const CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES = [
  "running",
  "complete",
] as const;

export type CaseLawCorpusIndexBackfillStatus =
  (typeof CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES)[number];

export const CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS = {
  RUNNING: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES[0],
  COMPLETE: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES[1],
} as const satisfies Record<string, CaseLawCorpusIndexBackfillStatus>;

/** Durable cursor for a blue-green corpus-index generation rebuild. */
export const caseLawCorpusIndexBackfills = p.pgTable(
  "case_law_corpus_index_backfills",
  {
    generation: p.varchar({ length: 32 }).primaryKey(),
    snapshotAt: timestamptz("snapshot_at").defaultNow().notNull(),
    cursorCreatedAt: timestamptz("cursor_created_at"),
    cursorId: safeUuid<"caseLawDecision">("cursor_id"),
    status: p
      .text({ enum: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES })
      .notNull()
      .default(CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING),
    /**
     * A rebuild page owns external index writes. Persisting this lease before
     * the write prevents two workers from appending the same documents; the
     * expiry makes a process crash recoverable.
     */
    leaseToken: p.uuid("lease_token"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.check(
      "case_law_corpus_index_backfills_status_values",
      sql`${t.status} IN (${sql.join(
        CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES.map((status) =>
          sql.raw(`'${status}'`),
        ),
        sql.raw(","),
      )})`,
    ),
    p.check(
      "case_law_corpus_index_backfills_cursor_pair",
      sql`(${t.cursorCreatedAt} IS NULL) = (${t.cursorId} IS NULL)`,
    ),
    p.check(
      "case_law_corpus_index_backfills_lease_pair",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseExpiresAt} IS NULL)`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

export const CASE_LAW_CORPUS_INDEX_PROJECTION_ACTIONS = [
  "index",
  "delete",
] as const;
export type CaseLawCorpusIndexProjectionAction =
  (typeof CASE_LAW_CORPUS_INDEX_PROJECTION_ACTIONS)[number];

/** Durable state and refresh queue for each active generation projection. */
export const caseLawCorpusIndexProjections = p.pgTable(
  "case_law_corpus_index_projections",
  {
    generation: p.varchar({ length: 32 }).notNull(),
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    indexId: p.varchar("index_id", { length: 64 }),
    indexedHash: p.varchar("indexed_hash", { length: 64 }),
    pendingAction: p.text("pending_action", {
      enum: CASE_LAW_CORPUS_INDEX_PROJECTION_ACTIONS,
    }),
    pendingHash: p.varchar("pending_hash", { length: 64 }),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      columns: [t.generation, t.decisionId],
      name: "case_law_corpus_index_projections_pk",
    }),
    p
      .foreignKey({
        name: "case_law_corpus_index_projections_generation_fk",
        columns: [t.generation],
        foreignColumns: [caseLawCorpusIndexBackfills.generation],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "case_law_corpus_index_projections_decision_fk",
        columns: [t.decisionId],
        foreignColumns: [caseLawDecisions.id],
      })
      .onDelete("cascade"),
    p.check(
      "case_law_corpus_index_projections_index_pair",
      sql`(${t.indexId} IS NULL) = (${t.indexedHash} IS NULL)`,
    ),
    p.check(
      "case_law_corpus_index_projections_pending_shape",
      sql`(${t.pendingAction} IS NULL AND ${t.pendingHash} IS NULL)
        OR (${t.pendingAction} = 'index' AND ${t.pendingHash} IS NOT NULL)
        OR (${t.pendingAction} = 'delete' AND ${t.pendingHash} IS NULL)`,
    ),
    p
      .index("case_law_corpus_index_projections_pending_idx")
      .on(t.generation, t.decisionId)
      .where(isNotNull(t.pendingAction)),
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
