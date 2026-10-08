import type { SQLWrapper } from "drizzle-orm";

import {
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_WINDOW_DISPOSITION_BASES,
  LEGISLATION_WINDOW_DISPOSITIONS,
} from "@stll/api-contract/legislation-expression";
import type { LegislationWindowDispositionBasis } from "@stll/api-contract/legislation-expression";
import { LEGISLATION_DOCUMENT_STATUSES } from "@stll/api-contract/legislation-status";
import { STATUTE_SLUG_PATTERN } from "@stll/api-contract/statute-route";

import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution-sql";
import {
  legislationVersionRef,
  notWithdrawn,
} from "@/api/lib/legal-search/legislation-validity-window";

import {
  caseLawIngestionOnlyPolicies,
  corpusSampleReaderPolicies,
  globalCaseLawPolicies,
  isNotNull,
  isNull,
  jsonb,
  p,
  pUuid,
  publicLawReaderPolicies,
  safeUuid,
  sql,
  stellaPublicLawReader,
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
  CORPUS_INDEX_JOB_SUCCEEDED_CHECKS,
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

const sqlValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql.raw(","),
  );

/**
 * Disposition and basis, paired: an effective version carries no basis, and
 * every other disposition names why. The IS NOT NULL is not redundant: a
 * CHECK passes on NULL, and `NULL IN (…)` is NULL.
 */
const WINDOW_DISPOSITION_BASIS_PAIRING = sql.join(
  [
    sql.raw(
      "(window_disposition = 'effective' AND window_disposition_basis IS NULL)",
    ),
    ...Object.entries(LEGISLATION_WINDOW_DISPOSITION_BASES).map(
      ([disposition, bases]) =>
        sql`(window_disposition = ${sql.raw(`'${disposition}'`)} AND (window_disposition_basis IS NOT NULL AND window_disposition_basis IN (${sqlValues(bases)})))`,
    ),
  ],
  sql.raw(" OR "),
);

/**
 * The prefix a source's publisher expression ids carry. Lower-case and
 * colon-free, so the first colon of a stored id always ends the namespace.
 */
export const LEGISLATION_EXPRESSION_NAMESPACE_PATTERN =
  "^[a-z][a-z0-9-]{0,31}$";

/** Sitemap shards a jurisdiction splits into once it outgrows one file. */
export const STATUTE_SITEMAP_BUCKET_COUNT = 64;
const STATUTE_SITEMAP_BUCKET_WIDTH = 2;

/**
 * The sitemap shard a statute belongs to, hashed on the ELI.
 *
 * The ELI is the Work key: every consolidation carries it, and it survives a
 * title repair that changes the Work's slug. Hashing the slug instead would
 * scatter one Work's consolidations across shards, so the shard reading them
 * could not tell which slug is canonical.
 *
 * The sitemap predicate and the index below are this one expression, so the
 * predicate stays seekable instead of hashing every row of a jurisdiction.
 */
export const statuteSitemapBucket = (eli: SQLWrapper) =>
  sql<string>`lpad(mod(hashtext(${eli})::bigint + ${sql.raw("2147483648")}, ${sql.raw(String(STATUTE_SITEMAP_BUCKET_COUNT))})::text, ${sql.raw(String(STATUTE_SITEMAP_BUCKET_WIDTH))}, '0')`;

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
    /**
     * The prefix of every publisher expression id stored under this source
     * (`<namespace>:<publisher id>`). Set once, by whoever registers the
     * source, and never changed: a trigger (migration
     * `20261003120000_legislation_expression_identity`) refuses both a change
     * and an id whose prefix does not match.
     */
    expressionNamespace: p.varchar("expression_namespace", { length: 32 }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.uniqueIndex("legislation_sources_adapter_key_idx").on(t.adapterKey),
    p.check(
      "legislation_sources_expression_namespace_shape",
      sql`${t.expressionNamespace} IS NULL OR ${t.expressionNamespace} ~ ${sql.raw(`'${LEGISLATION_EXPRESSION_NAMESPACE_PATTERN}'`)}`,
    ),
    ...globalCaseLawPolicies(),
    ...publicLawReaderPolicies(),
    ...corpusSampleReaderPolicies(),
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
    /**
     * The readable segment the public statute URL is addressed by, derived
     * from the citation and the short title (`89-2012-sb-obcansky-zakonik`).
     * Every Expression of a Work carries the same value, so a Work owns one
     * segment and its consolidations hang off it. Null for a document whose
     * ELI carries no citation tail; those stay reachable by id.
     */
    slug: p.varchar({ length: 256 }),
    country: p.varchar({ length: 3 }).notNull(),
    language: p.varchar({ length: 8 }).notNull(),
    documentType: p.varchar("document_type", { length: 128 }),
    status: p.varchar({ length: 32 }).notNull().default("current"),
    effectiveDate: p.date("effective_date"),
    versionValidFrom: p.date("version_valid_from"),
    versionValidTo: p.date("version_valid_to"),
    /**
     * The publisher's own identity for this version, prefixed with the
     * source's namespace. Set once, from null, and never changed afterwards
     * (trigger in migration `20261003120000_legislation_expression_identity`).
     * Null only on rows written before the writer supplied it; a scheduler
     * task claims those from the stored version IRI.
     */
    publisherExpressionId: p.varchar("publisher_expression_id", {
      length: 1024,
    }),
    expressionKind: p
      .varchar("expression_kind", {
        length: 16,
        enum: LEGISLATION_EXPRESSION_KINDS,
      })
      .notNull()
      .default("consolidation"),
    /** Whether the stored window can answer a point-in-time read. */
    windowDisposition: p
      .varchar("window_disposition", {
        length: 16,
        enum: LEGISLATION_WINDOW_DISPOSITIONS,
      })
      .notNull()
      .default("effective"),
    /** Why the version carries its disposition; see the pairing CHECK. */
    windowDispositionBasis: p
      .varchar("window_disposition_basis", { length: 32 })
      .$type<LegislationWindowDispositionBasis>(),
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
    /** The case-law twins' legislation counterparts; see that table. */
    indexedHash: p.varchar("indexed_hash", { length: 64 }),
    indexedGeneration: p.varchar("indexed_generation", { length: 64 }),
    indexedAt: timestamptz("indexed_at"),
    /** Monotonic fence advanced by each desired-state transaction. */
    projectionEpoch: p
      .bigint("projection_epoch", { mode: "bigint" })
      .default(0n)
      .notNull(),
    /**
     * Advanced by the database whenever the payload or the version identity
     * changes (migration `20260926150000_legislation_payload_revision`); a
     * write that supplies a different value is refused.
     */
    payloadRevision: p
      .bigint("payload_revision", { mode: "bigint" })
      .default(1n)
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
    p.check(
      "legislation_documents_expression_kind_values",
      sql`${t.expressionKind} IN (${sqlValues(LEGISLATION_EXPRESSION_KINDS)})`,
    ),
    p.check(
      "legislation_documents_window_disposition_values",
      sql`${t.windowDisposition} IN (${sqlValues(LEGISLATION_WINDOW_DISPOSITIONS)})`,
    ),
    p.check(
      "legislation_documents_window_disposition_basis_pairing",
      WINDOW_DISPOSITION_BASIS_PAIRING,
    ),
    p
      .uniqueIndex("legislation_documents_eli_version_lang_idx")
      .on(t.sourceId, t.eli, t.versionValidFrom, t.language)
      .where(isNotNull(t.versionValidFrom)),
    p
      .uniqueIndex("legislation_documents_eli_current_lang_idx")
      .on(t.sourceId, t.eli, t.language)
      .where(isNull(t.versionValidFrom)),
    // `legislation_documents_eli_version_lang_idx` plus the two fields that
    // decide whether a version may apply, so the listing's per-Work probes of
    // its eligible dated versions (first opening, wording count, last change)
    // stay index-only. Trailing keys rather than INCLUDE because the Drizzle
    // version in use cannot express INCLUDE.
    p
      .index("legislation_documents_eli_version_eligibility_idx")
      .on(
        t.sourceId,
        t.eli,
        t.versionValidFrom,
        t.language,
        t.windowDisposition,
        t.expressionKind,
      )
      .where(isNotNull(t.versionValidFrom)),
    p.index("legislation_documents_eli_idx").on(t.eli),
    // The public reader addresses a Work by (country, slug). Not unique: a
    // Work's consolidations all carry the segment, and a title repaired
    // between consolidations leaves the Work answering to both of its slugs.
    p
      .index("legislation_documents_country_slug_idx")
      .on(t.country, t.slug)
      .where(isNotNull(t.slug)),
    // A sitemap shard seeks its bucket and walks the Works in it; without the
    // bucket in the index the predicate is computed per row and every shard
    // request scans the jurisdiction's whole slug range.
    p
      .index("legislation_documents_sitemap_bucket_idx")
      .on(t.country, statuteSitemapBucket(t.eli), t.eli)
      .where(isNotNull(t.slug)),
    // Superseded by the listed-versions index below; dropped once no running
    // release still plans the refresh without the withdrawn filter.
    p
      .index("legislation_documents_sitemap_refresh_idx")
      .on(
        t.country,
        t.sourceId,
        t.eli,
        t.language,
        sql`coalesce(${t.versionValidFrom}, DATE '0001-01-01') DESC`,
        sql`${t.id} DESC`,
        // Keep the base column too: index-only scans need it to evaluate the sort expression.
        t.versionValidFrom,
        t.slug,
        t.updatedAt,
      )
      .where(isNotNull(t.slug)),
    // The sitemap lists only versions the publisher still lists, so its
    // covering path carries the same predicate and a withdrawn tombstone never
    // reaches the Work grouping.
    p
      .index("legislation_documents_sitemap_refresh_v2_idx")
      .on(
        t.country,
        t.sourceId,
        t.eli,
        t.language,
        sql`coalesce(${t.versionValidFrom}, DATE '0001-01-01') DESC`,
        sql`${t.id} DESC`,
        // Keep the base column too: index-only scans need it to evaluate the sort expression.
        t.versionValidFrom,
        t.slug,
        t.updatedAt,
      )
      .where(
        sql`${t.slug} IS NOT NULL AND ${notWithdrawn(legislationVersionRef(t))}`,
      ),
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
    // The same walk narrowed to one kind of act: without the type in the key
    // a rare kind (`ústavní zákon`) walks the whole jurisdiction to fill a page.
    p
      .index("legislation_documents_country_type_valid_from_id_idx")
      .on(
        t.country,
        t.documentType,
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
    // Indexes of the retired projection's markers, dropped with the columns.
    p
      .index("legislation_documents_indexed_idx")
      .on(t.indexedHash, t.contentHash),
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
    // The column is a public URL segment: whatever writes it, only the shape
    // the resolver and the route param accept may land here.
    p.check(
      "legislation_documents_slug_shape",
      sql`${t.slug} IS NULL OR ${t.slug} ~ ${sql.raw(`'${STATUTE_SLUG_PATTERN}'`)}`,
    ),
    ...globalCaseLawPolicies(),
    ...publicLawReaderPolicies(),
    ...corpusSampleReaderPolicies(),
  ],
);

/**
 * How a name in `legislation_work_names` was derived from stored titles. The
 * publisher's own title is not one of them: it is stored in its own column,
 * and a derived name can never land there (see the pairing CHECK).
 *
 * - `derived_title_segment`: the name part of a work's own title, the
 *   citation it opens with set aside and cut at the first comma;
 * - `derived_parenthetical`: a parenthesis inside such a name;
 * - `derived_title_citation`: the citation a work's own title opens with.
 *   It resolves citations other titles make and never names a work to a
 *   query by itself;
 * - `derived_from_citation`: the name another stored title gives a work
 *   beside its citation. The work is resolved at read time through
 *   `cited_key`, so a citing act stored before the cited one still counts.
 */
export const LEGISLATION_WORK_NAME_DERIVATIONS = [
  "derived_title_segment",
  "derived_parenthetical",
  "derived_title_citation",
  "derived_from_citation",
] as const;

export type LegislationWorkNameDerivation =
  (typeof LEGISLATION_WORK_NAME_DERIVATIONS)[number];

/** Longest match key stored; a longer name is kept unmatched. */
export const LEGISLATION_WORK_NAME_KEY_MAX_CHARS = 512;

/**
 * The names each stored legislation version's title states, for recognising
 * a query that names an act. Rebuilt per version from its title alone
 * (`syncLegislationWorkNamesTx`), so it is display-side search data: nothing
 * here feeds an applicability read, and no legislation row is changed by it.
 *
 * Every row is either the publisher's title as stored (`official_title`) or
 * a derived name (`derived_name` + `derivation`), never both.
 */
export const legislationWorkNames = p.pgTable(
  "legislation_work_names",
  {
    id: pUuid<"legislationWorkName">().primaryKey(),
    /** The version whose stored title states the name. */
    documentId: safeUuid<"legislationDocument">("document_id")
      .notNull()
      .references(() => legislationDocuments.id, { onDelete: "cascade" }),
    country: p.varchar({ length: 3 }).notNull(),
    /** The title exactly as the publisher states it. */
    officialTitle: p.text("official_title"),
    /** A name derived from stored titles; see `derivation`. */
    derivedName: p.text("derived_name"),
    derivation: p.varchar("derivation", {
      length: 32,
      enum: LEGISLATION_WORK_NAME_DERIVATIONS,
    }),
    /**
     * For `derived_from_citation`: the match key of the citation the name was
     * written beside, resolved against `derived_title_citation` rows.
     */
    citedKey: p.varchar("cited_key", {
      length: LEGISLATION_WORK_NAME_KEY_MAX_CHARS,
    }),
    /**
     * The name as a query is compared with it: case-folded word tokens joined
     * by one space (`legislationNameMatchKey`). Null for a name too long to
     * be typed.
     */
    matchKey: p.varchar("match_key", {
      length: LEGISLATION_WORK_NAME_KEY_MAX_CHARS,
    }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.check(
      "legislation_work_names_official_or_derived",
      sql`(${t.officialTitle} IS NOT NULL AND ${t.derivedName} IS NULL AND ${t.derivation} IS NULL) OR (${t.officialTitle} IS NULL AND ${t.derivedName} IS NOT NULL AND ${t.derivation} IS NOT NULL AND ${t.matchKey} IS NOT NULL)`,
    ),
    p.check(
      "legislation_work_names_derivation_values",
      sql`${t.derivation} IS NULL OR ${t.derivation} IN (${sqlValues(LEGISLATION_WORK_NAME_DERIVATIONS)})`,
    ),
    p.check(
      "legislation_work_names_cited_key_pairing",
      sql`(${t.derivation} IS NOT DISTINCT FROM 'derived_from_citation') = (${t.citedKey} IS NOT NULL)`,
    ),
    // One row per form a version states; also the per-version access path
    // the sync and the cascade read.
    p
      .unique("legislation_work_names_form_key")
      .on(t.documentId, t.derivation, t.citedKey, t.matchKey)
      .nullsNotDistinct(),
    // The name lookup and the citation resolution: equality on the key,
    // narrowed by country, answered from the index alone.
    p
      .index("legislation_work_names_match_key_idx")
      .on(t.matchKey, t.country, t.derivation, t.citedKey, t.documentId)
      .where(isNotNull(t.matchKey)),
    p.pgPolicy("legislation_work_name_owner_access", {
      for: "all",
      to: "public",
      using: sql`true`,
      withCheck: sql`true`,
    }),
    ...caseLawIngestionOnlyPolicies(),
    ...publicLawReaderPolicies(),
  ],
);

/** Public statute sitemap index, replaced as one snapshot by the scheduler. */
export const statuteSitemapShards = p.pgTable(
  "statute_sitemap_shards",
  {
    country: p.varchar({ length: 3 }).notNull(),
    bucket: p.varchar({ length: 3 }).notNull(),
    total: p.integer().notNull(),
    lastmod: p.varchar({ length: 10 }).notNull(),
  },
  (t) => [
    p.primaryKey({
      name: "statute_sitemap_shards_pkey",
      columns: [t.country, t.bucket],
    }),
    p.check("statute_sitemap_shards_total_positive", sql`${t.total} > 0`),
    p.pgPolicy("statute_sitemap_shard_owner_access", {
      for: "all",
      to: "public",
      using: sql`true`,
      withCheck: sql`true`,
    }),
    ...publicLawReaderPolicies(),
  ],
);

/**
 * Works per kind of act, per jurisdiction and source, replaced as one snapshot
 * by the scheduler. Counted per source so a public read applies the live
 * redistribution policy instead of a policy frozen into the count.
 */
export const legislationFacetCounts = p.pgTable(
  "legislation_facet_counts",
  {
    country: p.varchar({ length: 3 }).notNull(),
    sourceId: safeUuid<"legislationSource">("source_id")
      .notNull()
      .references(() => legislationSources.id, { onDelete: "cascade" }),
    documentType: p.varchar("document_type", { length: 128 }).notNull(),
    works: p.integer().notNull(),
  },
  (t) => [
    p.primaryKey({
      name: "legislation_facet_counts_pkey",
      columns: [t.country, t.sourceId, t.documentType],
    }),
    p.check("legislation_facet_counts_works_positive", sql`${t.works} > 0`),
    p.pgPolicy("legislation_facet_count_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legislation_facet_counts'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legislation_facet_counts'::regclass)`,
    }),
    p.pgPolicy("public_law_reader_access", {
      for: "select",
      to: stellaPublicLawReader,
      using: sql`EXISTS (
        SELECT 1
        FROM ${legislationSources} AS facet_source
        WHERE facet_source.id = ${t.sourceId}
          AND ${redistributableCaseLawSourceFor(sql`facet_source.descriptor`)}
      )`,
    }),
  ],
);

/**
 * When the statute facet snapshot last completed: one row, no source data.
 * Its presence, not the visibility of any bucket, is what tells a reader the
 * snapshot exists, so a source the reader may not see never sends it back to
 * the live aggregation.
 */
export const legislationFacetRefreshes = p.pgTable(
  "legislation_facet_refreshes",
  {
    singleton: p.boolean().primaryKey().default(true),
    refreshedAt: timestamptz("refreshed_at").notNull(),
  },
  (t) => [
    p.check("legislation_facet_refreshes_singleton", sql`${t.singleton}`),
    p.pgPolicy("legislation_facet_refresh_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legislation_facet_refreshes'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legislation_facet_refreshes'::regclass)`,
    }),
    ...publicLawReaderPolicies(),
  ],
);

/**
 * Works whose versions changed, one row per affected `(country, eli)`. Filled
 * only by triggers on `legislation_documents`: every insert and delete, and
 * every update that advances `payload_revision`. A queue, not a watermark;
 * ids order nothing.
 */
export const legislationWorkChanges = p.pgTable(
  "legislation_work_changes",
  {
    id: p
      .bigint({ mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity({ name: "legislation_work_changes_id_seq" }),
    country: p.varchar({ length: 3 }).notNull(),
    eli: p.varchar({ length: 512 }).notNull(),
    changedAt: timestamptz("changed_at").defaultNow().notNull(),
  },
  () => [
    ...caseLawIngestionOnlyPolicies(),
    // Row security is forced on this table (migration
    // `20260926150000_legislation_payload_revision`), so owner-context writes
    // to legislation_documents need a policy to append; grants limit it.
    p.pgPolicy("legislation_work_change_append", {
      for: "insert",
      to: "public",
      withCheck: sql`true`,
    }),
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
    ...publicLawReaderPolicies(),
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
      CORPUS_INDEX_JOB_SUCCEEDED_CHECKS.legislation_index_jobs,
      sql`${t.status} <> ${CORPUS_INDEX_JOB_SUCCEEDED_SQL_VALUE} OR ${t.errorMessage} IS NULL`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

// -- Chat --
