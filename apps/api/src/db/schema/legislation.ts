import type { SQLWrapper } from "drizzle-orm";

import { LEGISLATION_DOCUMENT_STATUSES } from "@stll/api-contract/legislation-status";

import {
  caseLawIngestionOnlyPolicies,
  globalCaseLawPolicies,
  isNotNull,
  isNull,
  jsonb,
  p,
  pUuid,
  publicLawReaderPolicies,
  safeUuid,
  sql,
  tsvector,
  timestamptz,
} from "./common";
import type {
  CorpusSourceDescriptor,
  DecisionSection,
  DocumentAst,
  EmptyAst,
} from "./common";
import {
  CORPUS_INDEX_JOB_OPERATION_SQL_VALUES,
  CORPUS_INDEX_JOB_STATUS_SQL_VALUES,
  CORPUS_INDEX_JOB_SUCCEEDED_SQL_VALUE,
} from "./corpus-index-jobs";
import type {
  CorpusIndexJobOperation,
  CorpusIndexJobStatus,
} from "./corpus-index-jobs";

/**
 * Lifecycle of a legislative text at a given point in time. The column stays
 * an unnarrowed varchar (the search filter accepts a free-form status string);
 * the CHECK below is what actually constrains the values, from the same
 * declaration every client renders.
 */
const LEGISLATION_DOCUMENT_STATUS_SQL_VALUES =
  LEGISLATION_DOCUMENT_STATUSES.map((status) => sql.raw(`'${status}'`));

/** Bounded prefix that owns stable public-list ordering. */
export const LEGISLATION_TITLE_SORT_KEY_CHARS = 52;

export const legislationTitleSortKey = (title: SQLWrapper) =>
  sql<string>`left(${title}, ${sql.raw(String(LEGISLATION_TITLE_SORT_KEY_CHARS))})`;

/**
 * The title as a lawyer types it: lower-case, diacritics folded. Migration
 * `20260901130000_legislation_title_fold` owns the function; the query side
 * folds its input (a bound string) through the same function so both sides
 * cannot drift.
 */
export const legislationTitleFold = (value: SQLWrapper | string) =>
  sql<string>`legislation_title_fold(${value})`;

/**
 * The name part of an official title. Czech titles open with the number and
 * collection (`89/2012 Sb., občanský zákoník`); Slovak titles carry the name
 * alone. Matching a typed name against this rather than the full title is
 * what lets the code itself outrank the acts amending it.
 */
export const legislationTitleName = (title: SQLWrapper) =>
  sql<string>`regexp_replace(${title}, '^[0-9]+/[0-9]{4} [^,]*, ', '')`;

export const legislationSources = p.pgTable(
  "legislation_sources",
  {
    id: pUuid<"legislationSource">().primaryKey(),
    adapterKey: p.varchar("adapter_key", { length: 64 }).notNull(),
    name: p.varchar({ length: 256 }).notNull(),
    enabled: p.boolean().default(true).notNull(),
    syncCursor: p.text("sync_cursor"),
    lastSyncAt: timestamptz("last_sync_at"),
    config: jsonb().$type<Record<string, unknown>>().default({}),
    descriptor: jsonb().$type<CorpusSourceDescriptor>(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.uniqueIndex("legislation_sources_adapter_key_idx").on(t.adapterKey),
    ...globalCaseLawPolicies(),
    ...publicLawReaderPolicies(),
  ],
);

export const legislationDocuments = p.pgTable(
  "legislation_documents",
  {
    id: pUuid<"legislationDocument">().primaryKey(),
    sourceId: safeUuid<"legislationSource">("source_id")
      .notNull()
      .references(() => legislationSources.id, { onDelete: "cascade" }),
    // European Legislation Identifier / national statute id — the work key
    // shared across consolidations.
    eli: p.varchar({ length: 512 }).notNull(),
    // Official titles can enumerate every amended act and have no bounded
    // maximum in the publisher's domain.
    title: p.text().notNull(),
    country: p.varchar({ length: 3 }).notNull(),
    language: p.varchar({ length: 8 }).notNull(),
    documentType: p.varchar("document_type", { length: 128 }),
    status: p.varchar({ length: 32 }).notNull().default("current"),
    effectiveDate: p.date("effective_date"),
    versionValidFrom: p.date("version_valid_from"),
    versionValidTo: p.date("version_valid_to"),
    fulltext: p.text(),
    sections: jsonb().$type<DecisionSection[]>(),
    documentAst: jsonb("document_ast").$type<DocumentAst | EmptyAst>(),
    sourceUrl: p.varchar("source_url", { length: 2048 }),
    documentUrl: p.varchar("document_url", { length: 2048 }),
    metadata: jsonb().$type<Record<string, unknown>>().default({}),
    sourceHash: p.varchar("source_hash", { length: 64 }),
    /**
     * Where the publisher's response for this Expression is kept, so
     * a later parser can be replayed without re-crawling. Content-addressed;
     * the twin of `case_law_decisions.source_raw_s3_key`.
     */
    sourceRawS3Key: p.varchar("source_raw_s3_key", { length: 512 }),
    sourceRawContentType: p.varchar("source_raw_content_type", { length: 128 }),
    // Reuse the corpus ranking signal (cross-reference authority); 0 until
    // a legislation-specific signal is computed.
    citationAuthority: p
      .doublePrecision("citation_authority")
      .default(0)
      .notNull(),
    citationCount: p.integer("citation_count").default(0).notNull(),
    citationAuthorityComputedAt: timestamptz("citation_authority_computed_at"),
    textS3Key: p.varchar("text_s3_key", { length: 512 }),
    normalizedS3Key: p.varchar("normalized_s3_key", { length: 512 }),
    astS3Key: p.varchar("ast_s3_key", { length: 512 }),
    contentHash: p.varchar("content_hash", { length: 64 }),
    indexedHash: p.varchar("indexed_hash", { length: 64 }),
    indexedGeneration: p.varchar("indexed_generation", { length: 64 }),
    indexedAt: timestamptz("indexed_at"),
    /** Monotonic fence advanced by each desired-state transaction. */
    projectionEpoch: p
      .bigint("projection_epoch", { mode: "bigint" })
      .default(0n)
      .notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.check(
      "legislation_documents_projection_epoch_nonnegative",
      sql`${t.projectionEpoch} >= 0`,
    ),
    p
      .uniqueIndex("legislation_documents_eli_version_lang_idx")
      .on(t.sourceId, t.eli, t.versionValidFrom, t.language)
      .where(isNotNull(t.versionValidFrom)),
    p
      .uniqueIndex("legislation_documents_eli_current_lang_idx")
      .on(t.sourceId, t.eli, t.language)
      .where(isNull(t.versionValidFrom)),
    p.index("legislation_documents_eli_idx").on(t.eli),
    // The point-in-time read seeks a Work by its identifier and takes the
    // latest window that opened on or before the requested date, so the
    // access path has to carry the language and the opening as well.
    p
      .index("legislation_documents_eli_lang_valid_from_idx")
      .on(t.eli, t.language, t.versionValidFrom),
    p.index("legislation_documents_country_idx").on(t.country),
    // Full titles are not B-tree-safe and cannot travel in a bounded cursor.
    // The canonical expression also owns the handler's tagged ordering.
    p
      .index("legislation_documents_country_title_sort_id_idx")
      .on(t.country, legislationTitleSortKey(t.title), t.id),
    // Its search filter matches anywhere in the title or the identifier, so
    // the access path has to be trigram rather than btree.
    p
      .index("legislation_documents_title_trgm_idx")
      .using("gin", sql`${t.title} gin_trgm_ops`),
    p
      .index("legislation_documents_eli_trgm_idx")
      .using("gin", sql`${t.eli} gin_trgm_ops`),
    // Diacritics-insensitive title matching, on the fold the handler queries
    // through (see `legislationTitleFold`).
    p
      .index("legislation_documents_title_fold_trgm_idx")
      .using("gin", sql`legislation_title_fold(${t.title}) gin_trgm_ops`),
    // The default listing walks a country newest consolidation first; the
    // expression is the handler's sort key, so the walk is an index range.
    p
      .index("legislation_documents_country_valid_from_id_idx")
      .on(
        t.country,
        sql`coalesce(${t.versionValidFrom}, DATE '0001-01-01')`,
        t.id,
      ),
    p.index("legislation_documents_status_idx").on(t.status),
    p.index("legislation_documents_effective_date_idx").on(t.effectiveDate),
    p.index("legislation_documents_created_at_idx").on(t.createdAt),
    p.index("legislation_documents_updated_id_idx").on(t.updatedAt, t.id),
    p
      .index("legislation_documents_citation_authority_idx")
      .on(t.citationAuthority),
    p
      .index("legislation_documents_indexed_idx")
      .on(t.indexedHash, t.contentHash),
    // Pending set for the corpus indexer's missing scan (see the case-law
    // twin for the reasoning).
    p
      .index("legislation_documents_corpus_pending_idx")
      .on(t.id)
      .where(
        sql`${t.contentHash} is not null and ${t.indexedGeneration} is null`,
      ),
    p
      .index("legislation_documents_corpus_hash_pending_idx")
      .on(t.id)
      .where(sql`${t.contentHash} is not null and ${t.indexedHash} is null`),
    p.check(
      "legislation_documents_status_values",
      sql`${t.status} IN (${sql.join(LEGISLATION_DOCUMENT_STATUS_SQL_VALUES, sql.raw(","))})`,
    ),
    ...globalCaseLawPolicies(),
    ...publicLawReaderPolicies(),
  ],
);

export const legislationSearchDocuments = p.pgTable(
  "legislation_search_documents",
  {
    documentId: safeUuid<"legislationDocument">("document_id")
      .primaryKey()
      .references(() => legislationDocuments.id, { onDelete: "cascade" }),
    title: p.text().notNull().default(""),
    searchableText: p.text("searchable_text").notNull().default(""),
    language: p.varchar("language", { length: 10 }),
    regconfig: p.varchar({ length: 64 }).notNull().default("simple"),
    tsv: tsvector(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    retryAfter: timestamptz("retry_after"),
  },
  (table) => [
    p.index("legislation_search_docs_tsv_idx").using("gin", table.tsv),
    p
      .index("legislation_search_docs_retry_idx")
      .on(table.retryAfter, table.documentId)
      .where(isNotNull(table.retryAfter)),
    ...globalCaseLawPolicies(),
  ],
);

export const legislationIndexJobs = p.pgTable(
  "legislation_index_jobs",
  {
    id: pUuid<"legislationIndexJob">().primaryKey(),
    documentId: safeUuid<"legislationDocument">("document_id").references(
      () => legislationDocuments.id,
      { onDelete: "cascade" },
    ),
    generation: p.varchar({ length: 64 }).notNull(),
    operation: p
      .varchar({ length: 16 })
      .notNull()
      .$type<CorpusIndexJobOperation>(),
    status: p.varchar({ length: 16 }).notNull().$type<CorpusIndexJobStatus>(),
    contentHash: p.varchar("content_hash", { length: 64 }),
    errorMessage: p.varchar("error_message", { length: 2048 }),
    /** Why a succeeded operation was performed; see the case-law twin. */
    detail: p.varchar("detail", { length: 2048 }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.index("legislation_index_jobs_document_idx").on(t.documentId),
    p.index("legislation_index_jobs_created_idx").on(t.createdAt),
    p.check(
      "legislation_index_jobs_operation_values",
      sql`${t.operation} IN (${sql.join(CORPUS_INDEX_JOB_OPERATION_SQL_VALUES, sql.raw(","))})`,
    ),
    p.check(
      "legislation_index_jobs_status_values",
      sql`${t.status} IN (${sql.join(CORPUS_INDEX_JOB_STATUS_SQL_VALUES, sql.raw(","))})`,
    ),
    // The case-law twin's invariant, on the same declaration: a succeeded row
    // carries no failure.
    p.check(
      "legislation_index_jobs_succeeded_error_message",
      sql`${t.status} <> ${CORPUS_INDEX_JOB_SUCCEEDED_SQL_VALUE} OR ${t.errorMessage} IS NULL`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

/** Highest engine delete task observed for each physical legislation index. */
export const legislationCorpusIndexDeleteWatermarks = p.pgTable(
  "legislation_corpus_index_delete_watermarks",
  {
    indexId: p.varchar("index_id", { length: 64 }).primaryKey(),
    opstamp: p.bigint({ mode: "number" }).notNull(),
    lastCheckedAt: timestamptz("last_checked_at"),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .index("legislation_corpus_index_delete_watermarks_check_idx")
      .on(t.lastCheckedAt),
    p.check(
      "legislation_corpus_index_delete_watermarks_nonnegative",
      sql`${t.opstamp} >= 0`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

/**
 * Documents whose accepted Quickwit delete task remains unapplied on one or
 * more published splits. The key makes task replay idempotent; the bounded
 * reconciler removes a row only after every split reaches its opstamp.
 */
export const legislationCorpusIndexPendingDeletes = p.pgTable(
  "legislation_corpus_index_pending_deletes",
  {
    indexId: p.varchar("index_id", { length: 64 }).notNull(),
    // No foreign key: source deletion must not erase settlement ownership
    // before the search engine has removed the legislation document.
    documentId: safeUuid<"legislationDocument">("document_id").notNull(),
    opstamp: p.bigint({ mode: "number" }).notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      name: "legislation_corpus_index_pending_deletes_pkey",
      columns: [t.indexId, t.documentId],
    }),
    p
      .index("legislation_corpus_index_pending_deletes_settlement_idx")
      .on(t.indexId, t.opstamp),
    p.check(
      "legislation_corpus_index_pending_deletes_nonnegative",
      sql`${t.opstamp} >= 0`,
    ),
    ...caseLawIngestionOnlyPolicies(),
  ],
);

// -- Chat --
