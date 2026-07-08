import {
  globalCaseLawPolicies,
  isNotNull,
  isNull,
  jsonb,
  p,
  pUuid,
  safeUuid,
  sql,
  tsvector,
} from "./common";
import type {
  CorpusSourceDescriptor,
  DecisionSection,
  DocumentAst,
  EmptyAst,
} from "./common";

export const legislationSources = p.pgTable(
  "legislation_sources",
  {
    id: pUuid<"legislationSource">().primaryKey(),
    adapterKey: p.varchar("adapter_key", { length: 64 }).notNull(),
    name: p.varchar({ length: 256 }).notNull(),
    enabled: p.boolean().default(true).notNull(),
    syncCursor: p.text("sync_cursor"),
    lastSyncAt: p.timestamp("last_sync_at"),
    config: jsonb().$type<Record<string, unknown>>().default({}),
    descriptor: jsonb().$type<CorpusSourceDescriptor>(),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
    updatedAt: p
      .timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.uniqueIndex("legislation_sources_adapter_key_idx").on(t.adapterKey),
    ...globalCaseLawPolicies(),
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
    title: p.varchar({ length: 1024 }).notNull(),
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
    // Reuse the corpus ranking signal (cross-reference authority); 0 until
    // a legislation-specific signal is computed.
    citationAuthority: p
      .doublePrecision("citation_authority")
      .default(0)
      .notNull(),
    citationCount: p.integer("citation_count").default(0).notNull(),
    citationAuthorityComputedAt: p.timestamp("citation_authority_computed_at"),
    textS3Key: p.varchar("text_s3_key", { length: 512 }),
    normalizedS3Key: p.varchar("normalized_s3_key", { length: 512 }),
    astS3Key: p.varchar("ast_s3_key", { length: 512 }),
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
      .uniqueIndex("legislation_documents_eli_version_lang_idx")
      .on(t.sourceId, t.eli, t.versionValidFrom, t.language)
      .where(isNotNull(t.versionValidFrom)),
    p
      .uniqueIndex("legislation_documents_eli_current_lang_idx")
      .on(t.sourceId, t.eli, t.language)
      .where(isNull(t.versionValidFrom)),
    p.index("legislation_documents_eli_idx").on(t.eli),
    p.index("legislation_documents_country_idx").on(t.country),
    p.index("legislation_documents_status_idx").on(t.status),
    p.index("legislation_documents_effective_date_idx").on(t.effectiveDate),
    p.index("legislation_documents_created_at_idx").on(t.createdAt),
    p
      .index("legislation_documents_citation_authority_idx")
      .on(t.citationAuthority),
    p
      .index("legislation_documents_indexed_idx")
      .on(t.indexedHash, t.contentHash),
    p.check(
      "legislation_documents_status_values",
      sql`${t.status} IN ('current','historical','repealed','draft')`,
    ),
    ...globalCaseLawPolicies(),
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
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("legislation_search_docs_tsv_idx").using("gin", table.tsv),
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
    p.index("legislation_index_jobs_document_idx").on(t.documentId),
    p.index("legislation_index_jobs_created_idx").on(t.createdAt),
    p.check(
      "legislation_index_jobs_operation_values",
      sql`${t.operation} IN ('index','delete','redact','rebuild')`,
    ),
    p.check(
      "legislation_index_jobs_status_values",
      sql`${t.status} IN ('succeeded','failed')`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

// -- Chat --
