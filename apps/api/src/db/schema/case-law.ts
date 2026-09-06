import { eq } from "drizzle-orm";

import {
  CASE_LAW_RESEARCH_ANSWER_STATES,
  CASE_LAW_RESEARCH_ANSWER_TYPES,
  CASE_LAW_RESEARCH_DISPOSITIONS,
} from "@stll/api-contract";
import type {
  CaseLawResearchAnswerRun,
  CaseLawResearchAnswerValue,
  CaseLawResearchColumnTool,
  CaseLawResearchSavedQuery,
} from "@stll/api-contract";
import {
  DECISION_IDENTIFIER_MAX_LENGTH,
  DECISION_IDENTIFIER_TYPES,
} from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import { CITATION_DECISION_TYPE_HINTS } from "@/api/handlers/case-law/citation-decision-type-hint";
import { CITATION_KINDS } from "@/api/handlers/case-law/citation-kind";
import {
  CITATION_AMBIGUITY_SHAPES,
  CITATION_CENSUS_ROW_KINDS,
  CITATION_CENSUS_RULE_BUCKETS,
  CITATION_CENSUS_RUN_STATUSES,
} from "@/api/handlers/case-law/citation-resolution-census-consts";
import {
  CITATION_RESOLUTION_RULES,
  CITATION_RESOLUTION_SCOPES,
  CITATION_RESOLUTION_STATUS,
  CITATION_RESOLUTION_STATUSES,
  citationReopenableByKeySql,
  effectiveCitationIdentifierTypeSql,
  effectiveCitationIdentifierValueSql,
  settledCitationSql,
  unsettledCitationSql,
} from "@/api/handlers/case-law/citation-resolution-status";
import {
  POLARITIES,
  RULE_SOURCE,
  RULE_SOURCES,
} from "@/api/handlers/case-law/polarity/consts";
import type {
  Polarity,
  RuleSource,
} from "@/api/handlers/case-law/polarity/consts";
import type { ConstantMap } from "@/api/lib/constant-map";
import {
  CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT,
  decisionDateWithinBoundsSql,
} from "@/api/lib/decision-date-bounds-sql";

import {
  authoredNotePolicies,
  caseLawIngestionOnlyPolicies,
  globalCaseLawPolicies,
  isNotNull,
  isNull,
  jsonb,
  organization,
  orgPolicies,
  p,
  pUuid,
  publicCaseLawReaderPolicies,
  publicLawReaderPolicies,
  safeOrganizationId,
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

/** The declaration the column's `enum` and the CHECK both derive from. */
const CASE_LAW_CORPUS_MIRROR_STATUSES = ["settled", "pending"] as const;

type CaseLawCorpusMirrorStatus =
  (typeof CASE_LAW_CORPUS_MIRROR_STATUSES)[number];

export const CASE_LAW_CORPUS_MIRROR_STATUS = {
  PENDING: "pending",
  SETTLED: "settled",
} as const satisfies ConstantMap<CaseLawCorpusMirrorStatus>;

export const CASE_LAW_CORPUS_UPLOAD_INTENT_STATUSES = [
  "active",
  "cleanup",
] as const;

export const CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS = {
  ACTIVE: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUSES[0],
  CLEANUP: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUSES[1],
} as const;

/**
 * How a source's reported total was obtained. Not a boolean: a third
 * provenance (an operator-approved import, say) must be able to land as a
 * new member rather than as a second flag.
 */
export const SOURCE_TOTAL_ORIGIN = {
  ADAPTER_POLL: "adapter-poll",
  OPERATOR: "operator",
} as const;

export type SourceTotalOrigin =
  (typeof SOURCE_TOTAL_ORIGIN)[keyof typeof SOURCE_TOTAL_ORIGIN];

const CASE_LAW_CORPUS_MIRROR_STATUS_SQL_VALUES =
  CASE_LAW_CORPUS_MIRROR_STATUSES.map((status) => sql.raw(`'${status}'`));

const CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS_SQL_VALUES =
  CASE_LAW_CORPUS_UPLOAD_INTENT_STATUSES.map((status) =>
    sql.raw(`'${status}'`),
  );

const POLARITY_SQL_VALUES = POLARITIES.map((polarity) =>
  sql.raw(`'${polarity}'`),
);

const CITATION_KIND_SQL_VALUES = CITATION_KINDS.map((kind) =>
  sql.raw(`'${kind}'`),
);

const CITATION_DECISION_TYPE_HINT_SQL_VALUES = CITATION_DECISION_TYPE_HINTS.map(
  (hint) => sql.raw(`'${hint}'`),
);

const CITATION_RESOLUTION_STATUS_SQL_VALUES = CITATION_RESOLUTION_STATUSES.map(
  (status) => sql.raw(`'${status}'`),
);

const CITATION_RESOLUTION_RULE_SQL_VALUES = CITATION_RESOLUTION_RULES.map(
  (rule) => sql.raw(`'${rule}'`),
);

export const PROVISION_UNITS = ["section", "article"] as const;

export const PROVISION_WORK_SOURCES = [
  "number",
  "alias",
  "title",
  "definition",
  "carry-over",
] as const;

const PROVISION_UNIT_SQL_VALUES = PROVISION_UNITS.map((unit) =>
  sql.raw(`'${unit}'`),
);

const PROVISION_WORK_SOURCE_SQL_VALUES = PROVISION_WORK_SOURCES.map((source) =>
  sql.raw(`'${source}'`),
);

const CITATION_RESOLUTION_SCOPE_SQL_VALUES = CITATION_RESOLUTION_SCOPES.map(
  (scope) => sql.raw(`'${scope}'`),
);

const RULE_SOURCE_SQL_VALUES = RULE_SOURCES.map((source) =>
  sql.raw(`'${source}'`),
);

const DECISION_IDENTIFIER_TYPE_SQL_VALUES = Object.values(
  DECISION_IDENTIFIER_TYPES,
).map((type) => sql.raw(`'${type}'`));

export const caseLawSources = p.pgTable(
  "case_law_sources",
  {
    id: pUuid<"caseLawSource">().primaryKey(),
    adapterKey: p.varchar("adapter_key", { length: 64 }).notNull(),
    name: p.varchar({ length: 256 }).notNull(),
    enabled: p.boolean().default(true).notNull(),
    syncCursor: p.text("sync_cursor"),
    lastSyncAt: timestamptz("last_sync_at"),
    observationOrder: p
      .bigint("observation_order", { mode: "bigint" })
      .default(0n)
      .notNull(),
    checkpointObservationOrder: p
      .bigint("checkpoint_observation_order", { mode: "bigint" })
      .default(0n)
      .notNull(),
    ingestionLeaseToken: p.uuid("ingestion_lease_token"),
    ingestionLeaseExpiresAt: timestamptz("ingestion_lease_expires_at"),
    config: jsonb().$type<Record<string, unknown>>().default({}),
    // License / redistribution terms. null = legacy source (public
    // court records, treated as redistributable); see corpus-source.ts. A
    // migration-owned trigger validates inserts and descriptor changes while
    // permitting unrelated checkpoint updates on legacy malformed rows.
    descriptor: jsonb().$type<CorpusSourceDescriptor>(),
    /**
     * How many decisions the publisher itself reports holding, with when it
     * was observed and where the number came from. Held-vs-total coverage is
     * otherwise uncomputable for a publisher that exposes no cheap count.
     *
     * The three are one fact and move together — all set or all null. The
     * writer (`ingestion/source-totals.ts`) validates the number at the
     * boundary so a caller gets a usable error; the check constraints below
     * make the half-written states unrepresentable for every other path.
     */
    reportedTotal: p.integer("reported_total"),
    reportedTotalAsOf: timestamptz("reported_total_as_of"),
    reportedTotalOrigin: p
      .varchar("reported_total_origin", { length: 16 })
      .$type<SourceTotalOrigin>(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.check(
      "case_law_sources_checkpoint_observation_order_monotonic",
      sql`${t.checkpointObservationOrder} <= ${t.observationOrder}`,
    ),
    p.check(
      "case_law_sources_ingestion_lease_pair",
      sql`(${t.ingestionLeaseToken} IS NULL) = (${t.ingestionLeaseExpiresAt} IS NULL)`,
    ),
    p.check(
      "case_law_sources_reported_total_trio",
      sql`(${t.reportedTotal} IS NULL) = (${t.reportedTotalAsOf} IS NULL)
        AND (${t.reportedTotal} IS NULL) = (${t.reportedTotalOrigin} IS NULL)`,
    ),
    p.check(
      "case_law_sources_reported_total_positive",
      sql`${t.reportedTotal} IS NULL OR ${t.reportedTotal} > 0`,
    ),
    // The accepted values are read off SOURCE_TOTAL_ORIGIN rather than
    // re-listed, so a new origin cannot reach the database without also
    // reaching this constraint.
    p.check(
      "case_law_sources_reported_total_origin_allowed",
      sql`${t.reportedTotalOrigin} IS NULL OR ${t.reportedTotalOrigin} IN (${sql.join(
        Object.values(SOURCE_TOTAL_ORIGIN).map((origin) => sql`${origin}`),
        sql`, `,
      )})`,
    ),
    // Deliberately no CHECK tying `adapter_key` to the adapter registry. The
    // registry is deployment state and the rows are history: a retired adapter
    // leaves a legitimate row behind, and a constraint would either block the
    // retirement or freeze one deployment's registry into the schema. Registry
    // membership is decided at read time instead, where a key with no adapter
    // is reported as unrecognized rather than silently ignored.
    p.uniqueIndex("case_law_sources_adapter_key_idx").on(t.adapterKey),
    ...globalCaseLawPolicies(),
    ...publicCaseLawReaderPolicies(),
  ],
);

/**
 * Jurisdictions ever observed in the case-law corpus.
 *
 * A migration-owned trigger derives this registry from decision writes. Census
 * reads it instead of scanning the multi-million-row decision table merely to
 * rediscover a handful of country codes. Rows are intentionally append-only:
 * an emptied jurisdiction still names an index whose surplus must remain
 * visible to the rollout gate.
 */
export const caseLawCorpusJurisdictions = p.pgTable(
  "case_law_corpus_jurisdictions",
  {
    country: p.varchar({ length: 3 }).primaryKey(),
    firstObservedAt: timestamptz("first_observed_at").defaultNow().notNull(),
  },
  () => [...globalCaseLawPolicies()],
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
    // A migration-owned trigger validates inserts and actual country changes,
    // while permitting unrelated updates that repair legacy malformed rows.
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
    sourceObservedAt: timestamptz("source_observed_at"),
    sourceObservationOrder: p.bigint("source_observation_order", {
      mode: "bigint",
    }),
    sourceObservationHash: p.varchar("source_observation_hash", { length: 64 }),
    redactedAt: timestamptz("redacted_at"),
    corpusMirrorStatus: p
      .varchar("corpus_mirror_status", {
        length: 16,
        enum: CASE_LAW_CORPUS_MIRROR_STATUSES,
      })
      .default(CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED)
      .notNull(),
    /**
     * Materialized citation-authority ranking signal: the
     * ln(1 + weighted-citation-sum) value that `citationScore()`
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
     * `indexedGeneration` is the physical index the row was last written
     * into (e.g. case_law_v1_sk: generation plus jurisdiction).
     */
    contentHash: p.varchar("content_hash", { length: 64 }),
    indexedHash: p.varchar("indexed_hash", { length: 64 }),
    indexedGeneration: p.varchar("indexed_generation", { length: 64 }),
    indexedAt: timestamptz("indexed_at"),
    /**
     * Monotonic fence captured by final-generation projection intents. Any
     * desired-state transaction increments it before changing the projection,
     * so a worker leased against an older value cannot publish stale content.
     */
    projectionEpoch: p
      .bigint("projection_epoch", { mode: "bigint" })
      .default(0n)
      .notNull(),
    createdAt: timestamptz("created_at")
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.check(
      "case_law_decisions_projection_epoch_nonnegative",
      sql`${t.projectionEpoch} >= 0`,
    ),
    p.check(
      "case_law_decisions_corpus_mirror_status_values",
      sql`${t.corpusMirrorStatus} IN (${sql.join(CASE_LAW_CORPUS_MIRROR_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "case_law_decisions_pending_corpus_mirror_has_no_pointers",
      sql`${t.corpusMirrorStatus} = 'settled' OR (${t.textS3Key} IS NULL AND ${t.normalizedS3Key} IS NULL AND ${t.astS3Key} IS NULL AND ${t.contentHash} IS NULL)`,
    ),
    p.check(
      "case_law_decisions_redacted_payload_erased",
      sql`${t.redactedAt} IS NULL OR (${t.fulltext} IS NULL AND ${t.sections} IS NULL AND ${t.documentAst} IS NULL AND ${t.contentHash} IS NULL)`,
    ),
    // The bounds `canonicalDecisionDate` enforces on the write path,
    // enforced at the table as well; both derive from `DECISION_DATE_BOUNDS`.
    // A NULL date is allowed: it is how a decision without a usable date is
    // stored.
    p.check(
      CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT,
      sql`${t.decisionDate} IS NULL OR ${decisionDateWithinBoundsSql(t.decisionDate)}`,
    ),
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
    // The generation rebuild walks its snapshot in decision-date order, so the
    // documents one split receives cover a contiguous span of dates and a
    // timestamp-filtered query can skip the splits outside its window. The
    // expression, direction and tiebreaker mirror the walk's ORDER BY exactly,
    // so a page is an index range rather than a sort of the corpus. Undated
    // decisions coalesce to `-infinity`: they sort first, as one band, matching
    // the earliest-possible timestamp their documents carry.
    p
      .index("case_law_decisions_corpus_generation_date_cursor_idx")
      .on(sql`coalesce(${t.decisionDate}, '-infinity'::date)`, t.id),
    // The public browse walk scoped to one court reads the same sort key
    // newest first; led by country and court so a small court's walk is its
    // own index range instead of a skip through the corpus-wide date index.
    p
      .index("case_law_decisions_country_court_date_idx")
      .on(
        t.country,
        t.court,
        sql`coalesce(${t.decisionDate}, '-infinity'::date)`,
        t.id,
      ),
    p
      .index("case_law_decisions_source_generation_cursor_idx")
      .on(t.sourceId, t.createdAt, t.id),
    p
      .index("case_law_decisions_updated_id_idx")
      .on(t.updatedAt.desc(), t.id.desc()),
    p
      .index("case_law_decisions_citation_authority_idx")
      .on(t.citationAuthority),
    // The authority sweep's whole bookkeeping. It takes the least recently
    // computed decisions older than its staleness boundary, and recomputing
    // one stamps it with the current instant, which puts it past the boundary:
    // the walk advances by doing its work, with no cursor to persist. That
    // only holds if the ordering is an index range rather than a sort of the
    // corpus, so the direction and null placement here have to match the
    // statement's ORDER BY exactly. Never-computed rows sort first, which is
    // what makes the same mechanism serve the initial backfill.
    p
      .index("case_law_decisions_authority_due_idx")
      .on(t.citationAuthorityComputedAt.asc().nullsFirst(), t.id),
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
    // The resolver's candidate lookup, answered entirely from the index. The
    // key alone finds the candidates; jurisdiction and date are what decide
    // between them, and the target id is what gets written. Carrying all four
    // keeps the per-citation cost to one index probe instead of a probe plus a
    // heap fetch per candidate, which on a corpus of this size is the
    // difference between a resolution pass that fits in cache and one that
    // reads the decisions table at random.
    //
    // `id` is a fourth key column rather than an INCLUDE payload only because
    // the Drizzle version in use cannot express INCLUDE; the two are the same
    // index-only scan here, since nothing ever ranges on `id` in this order.
    //
    // This replaces the plain `(citation_key) WHERE citation_key IS NOT NULL`
    // index it is a strict prefix of. Keeping both would have cost a few
    // hundred megabytes of cache on the same instance that has to hold this
    // one, to serve queries this index already answers.
    p
      .index("case_law_decisions_citation_candidate_idx")
      .on(t.citationKey, t.country, t.decisionDate, t.id)
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
    // Same rule as on the citation side: null means "does not canonicalize",
    // and an empty string would make every such decision a candidate for
    // every such citation.
    p.check("decisions_citation_key_non_empty", sql`${t.citationKey} <> ''`),
    ...globalCaseLawPolicies(),
    ...publicCaseLawReaderPolicies(),
  ],
);

/** Searchable identifiers stated by a decision's publisher. */
export const caseLawDecisionIdentifiers = p.pgTable(
  "case_law_decision_identifiers",
  {
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    type: p.varchar({ length: 32 }).$type<DecisionIdentifierType>().notNull(),
    value: p.varchar({ length: DECISION_IDENTIFIER_MAX_LENGTH }).notNull(),
    normalizedValue: p
      .varchar("normalized_value", {
        length: DECISION_IDENTIFIER_MAX_LENGTH,
      })
      .notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      columns: [t.decisionId, t.type, t.normalizedValue],
      name: "case_law_decision_identifiers_pk",
    }),
    p
      .foreignKey({
        columns: [t.decisionId],
        foreignColumns: [caseLawDecisions.id],
        name: "case_law_decision_identifiers_decision_id_fk",
      })
      .onDelete("cascade"),
    p
      .index("case_law_decision_identifiers_lookup_idx")
      .on(t.type, t.normalizedValue, t.decisionId),
    p.check(
      "case_law_decision_identifiers_type_values",
      sql`${t.type} IN (${sql.join(DECISION_IDENTIFIER_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "case_law_decision_identifiers_value_non_empty",
      sql`${t.value} <> '' AND ${t.normalizedValue} <> ''`,
    ),
    ...globalCaseLawPolicies(),
    ...publicLawReaderPolicies(),
  ],
);

export const CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASES = [
  "decisions",
  "citations",
  "verify-decisions",
  "verify-citations",
  "complete",
] as const;

export type CaseLawDecisionIdentifierBackfillPhase =
  (typeof CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASES)[number];

export const CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE = {
  DECISIONS: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASES[0],
  CITATIONS: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASES[1],
  VERIFY_DECISIONS: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASES[2],
  VERIFY_CITATIONS: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASES[3],
  COMPLETE: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASES[4],
} as const satisfies ConstantMap<CaseLawDecisionIdentifierBackfillPhase>;

/**
 * Durable progress and completion receipt for the typed-identifier rollout.
 *
 * One versioned row owns one restartable phase walk. The maintenance lane keeps
 * operator runs from overlapping; the row lock keeps page writes and cursor
 * advancement atomic. A completed row is only written after the verifier
 * observes no legacy decisions or citations, so it is evidence for removing
 * the resolver's temporary docket bridge rather than merely evidence that a
 * process reached the end of its input once.
 */
export const caseLawDecisionIdentifierBackfills = p.pgTable(
  "case_law_decision_identifier_backfills",
  {
    version: p.varchar({ length: 32 }).primaryKey(),
    phase: p
      .text({ enum: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASES })
      .notNull()
      .default(CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS),
    cursorId: p.uuid("cursor_id"),
    decisionsScanned: p
      .bigint("decisions_scanned", { mode: "number" })
      .notNull()
      .default(0),
    citationsScanned: p
      .bigint("citations_scanned", { mode: "number" })
      .notNull()
      .default(0),
    completedAt: timestamptz("completed_at"),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.check(
      "case_law_decision_identifier_backfills_phase_values",
      sql`${t.phase} IN (${sql.join(
        CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASES.map((phase) =>
          sql.raw(`'${phase}'`),
        ),
        sql.raw(","),
      )})`,
    ),
    p.check(
      "case_law_decision_identifier_backfills_counts_nonnegative",
      sql`${t.decisionsScanned} >= 0 AND ${t.citationsScanned} >= 0`,
    ),
    p.check(
      "case_law_decision_identifier_backfills_terminal_shape",
      sql`(${t.phase} = ${CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE}) = (${t.completedAt} IS NOT NULL)`,
    ),
    p.check(
      "case_law_decision_identifier_backfills_terminal_cursor",
      sql`${t.phase} <> ${CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE} OR ${t.cursorId} IS NULL`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

/**
 * Durable ownership for every exact publisher identity observed for a
 * decision. `decisionId` intentionally has no foreign key: identity is
 * reserved before the decision row is inserted, so overlapping canonical and
 * fallback observations converge on the same UUID instead of racing two
 * uniqueness keys. A later retry completes any reservation whose worker died.
 */
export const caseLawDecisionSourceIdentities = p.pgTable(
  "case_law_decision_source_identities",
  {
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "cascade" }),
    sourceDocumentId: p
      .varchar("source_document_id", { length: 256 })
      .notNull(),
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      columns: [t.sourceId, t.sourceDocumentId],
      name: "case_law_decision_source_identities_pk",
    }),
    p
      .index("case_law_decision_source_identities_decision_idx")
      .on(t.decisionId),
    ...caseLawIngestionOnlyPolicies(),
  ],
);

/**
 * Exact corpus-object keys reserved before an external PUT. This deliberately
 * has no foreign key: a redaction or source deletion must not remove the
 * cleanup ownership record before the root scheduler has erased its objects.
 */
export const caseLawCorpusUploadIntents = p.pgTable(
  "case_law_corpus_upload_intents",
  {
    id: pUuid<"caseLawCorpusUploadIntent">().primaryKey(),
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    textS3Key: p.varchar("text_s3_key", { length: 512 }).notNull(),
    normalizedS3Key: p
      .varchar("normalized_s3_key", {
        length: 512,
      })
      .notNull(),
    astS3Key: p.varchar("ast_s3_key", { length: 512 }).notNull(),
    status: p
      .varchar({
        length: 16,
        enum: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUSES,
      })
      .default(CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE)
      .notNull(),
    leaseExpiresAt: timestamptz("lease_expires_at").notNull(),
    cleanupAttemptCount: p
      .integer("cleanup_attempt_count")
      .default(0)
      .notNull(),
    nextCleanupAt: timestamptz("next_cleanup_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .uniqueIndex("case_law_corpus_upload_intents_active_decision_uidx")
      .on(t.decisionId)
      .where(eq(t.status, CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE)),
    p
      .index("case_law_corpus_upload_intents_cleanup_due_idx")
      .on(t.nextCleanupAt, t.id)
      .where(eq(t.status, CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP)),
    p
      .index("case_law_corpus_upload_intents_active_lease_idx")
      .on(t.leaseExpiresAt, t.id)
      .where(eq(t.status, CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE)),
    p.check(
      "case_law_corpus_upload_intents_status_values",
      sql`${t.status} IN (${sql.join(CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "case_law_corpus_upload_intents_cleanup_schedule",
      sql`${t.status} <> 'cleanup' OR ${t.nextCleanupAt} IS NOT NULL`,
    ),
    p.check(
      "case_law_corpus_upload_intents_cleanup_attempts_nonnegative",
      sql`${t.cleanupAttemptCount} >= 0`,
    ),
    ...caseLawIngestionOnlyPolicies(),
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
    /**
     * The source's own count for this slice; null while the slice has never
     * been listed successfully (see `walkError`).
     */
    reported: p.integer(),
    /** What the crawl produced for it; null with `reported`. */
    collected: p.integer(),
    checkedAt: timestamptz("checked_at").defaultNow().notNull(),
    /**
     * Why the last listing walk of this slice failed, null when it listed.
     * A row is either counted or failed, never neither: a slice the publisher
     * cannot list is still recorded, so the historical sweep moves past it
     * and the retry arm owns it instead.
     */
    walkError: p.text("walk_error"),
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
    // The retry arm reads failed rows oldest-checked first.
    p
      .index("case_law_coverage_slices_failed_idx")
      .on(t.sourceId, t.checkedAt)
      .where(sql`${t.walkError} IS NOT NULL`),
    p.check(
      "case_law_coverage_slices_counts_pair",
      sql`(${t.reported} IS NULL) = (${t.collected} IS NULL)`,
    ),
    p.check(
      "case_law_coverage_slices_counted_or_failed",
      sql`${t.reported} IS NOT NULL OR ${t.walkError} IS NOT NULL`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

/**
 * Where a listed decision sits once it has repeatedly refused to be ingested.
 *
 * The reconciliation loop hunts the difference between what a publisher lists
 * for a slice and what is held. Without this, an item the publisher lists but
 * never serves is re-fetched on every visit and the slice never settles: the
 * hunt has no fixed point. A row here is that item's memory — how often it has
 * been tried, when it may be tried again, and, once the schedule is exhausted,
 * that it is `terminal` and counts as accounted for rather than missing.
 */
export const RECONCILIATION_ITEM_STATUSES = ["parked", "terminal"] as const;

export const RECONCILIATION_ITEM_STATUS = {
  /** Awaiting its next attempt; `next_attempt_at` says when. */
  PARKED: RECONCILIATION_ITEM_STATUSES[0],
  /** The retry schedule is exhausted; nothing re-attempts this on its own. */
  TERMINAL: RECONCILIATION_ITEM_STATUSES[1],
} as const;

export type ReconciliationItemStatus =
  (typeof RECONCILIATION_ITEM_STATUS)[keyof typeof RECONCILIATION_ITEM_STATUS];

export const caseLawReconciliationItems = p.pgTable(
  "case_law_reconciliation_items",
  {
    id: pUuid<"caseLawReconciliationItem">().primaryKey(),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "cascade" }),
    /** The slice the item was listed in; matches `case_law_coverage_slices`. */
    slice: p.varchar({ length: 64 }).notNull(),
    /** `document:<id>` or `case-number:<language>:<docket>`; see `listingIdentityKey`. */
    identityKey: p.varchar("identity_key", { length: 320 }).notNull(),
    /** The listing item verbatim, so a retry needs no second listing walk. */
    payload: jsonb().$type<unknown>().notNull(),
    status: p
      .varchar({ length: 16, enum: RECONCILIATION_ITEM_STATUSES })
      .default(RECONCILIATION_ITEM_STATUS.PARKED)
      .notNull(),
    attempts: p.integer().default(0).notNull(),
    nextAttemptAt: timestamptz("next_attempt_at"),
    /** Error tags only; a raw message may carry more than an operator asked for. */
    lastError: p.text("last_error"),
    firstSeenAt: timestamptz("first_seen_at").defaultNow().notNull(),
    lastAttemptAt: timestamptz("last_attempt_at"),
  },
  (t) => [
    p
      .uniqueIndex("case_law_reconciliation_items_source_identity_idx")
      .on(t.sourceId, t.identityKey),
    // The due-retry read is the loop's highest-priority work unit, and it
    // asks only about parked rows; terminal ones are dead weight in it.
    p
      .index("case_law_reconciliation_items_due_idx")
      .on(t.sourceId, t.nextAttemptAt)
      .where(eq(t.status, RECONCILIATION_ITEM_STATUS.PARKED)),
    // Settledness per slice: a slice is done when what is held plus what is
    // terminal accounts for everything the publisher listed.
    p
      .index("case_law_reconciliation_items_slice_idx")
      .on(t.sourceId, t.slice, t.status),
    // The accepted values are read off RECONCILIATION_ITEM_STATUS rather
    // than restated, so a new member cannot land without the database
    // learning about it.
    p.check(
      "case_law_reconciliation_items_status_values",
      sql`${t.status} IN (${sql.join(
        Object.values(RECONCILIATION_ITEM_STATUS).map((value) => sql`${value}`),
        sql`, `,
      )})`,
    ),
    p.check(
      "case_law_reconciliation_items_attempts_nonnegative",
      sql`${t.attempts} >= 0`,
    ),
    // A parked row with no due time would never be selected again, which is
    // the silent version of terminal without the accounting terminal brings.
    p.check(
      "case_law_reconciliation_items_parked_is_scheduled",
      sql`${t.status} <> ${RECONCILIATION_ITEM_STATUS.PARKED} OR ${t.nextAttemptAt} IS NOT NULL`,
    ),
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
    /** Typed lookup identity; null only on rows written before its rollout. */
    identifierType: p
      .varchar("identifier_type", { length: 32 })
      .$type<DecisionIdentifierType>(),
    normalizedIdentifierValue: p.varchar("normalized_identifier_value", {
      length: DECISION_IDENTIFIER_MAX_LENGTH,
    }),
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
    /**
     * The decision-type word the citing text introduced the number with
     * ("nález sp. zn. …", "usnesením … č. j. …"), as a family from
     * `citation-decision-type-hint.ts`; null when the text did not say. The
     * resolver prefers a candidate of that type over any inference about
     * the file, which is what tells the nález from the orders that share
     * its docket number. Plain string for the same reason `kind` is.
     */
    citedDecisionTypeHint: p.varchar("cited_decision_type_hint", {
      length: 16,
    }),
    /**
     * The court phrase the citing text named, verbatim ("Krajského soudu v
     * Českých Budějovicích"); null when the sentence did not take the
     * standard form. See `citation-court-hint.ts`. The resolver matches it
     * against each candidate's court, which is what tells apart regional
     * dockets that several courts reuse.
     */
    citedCourtHint: p.varchar("cited_court_hint", { length: 128 }),
    /**
     * Outcome of the last resolution attempt. Split from the nullability of
     * `citedDecisionId` because a null foreign key cannot tell "not examined"
     * from "examined, nothing honest to link to": with both meanings on one
     * column the resolver's predicate never emptied and it re-examined the
     * permanent residue on every pass. See `citation-resolution-status.ts`.
     */
    resolutionStatus: p
      .text("resolution_status", { enum: CITATION_RESOLUTION_STATUSES })
      .notNull()
      .default(CITATION_RESOLUTION_STATUS.PENDING),
    /** When that outcome was decided; null until the row is first examined. */
    resolutionAttemptedAt: timestamptz("resolution_attempted_at"),
    /**
     * The rule that drew the edge of a `resolved` row; null otherwise, and
     * cleared whenever the row is reopened. A constant, not a foreign key:
     * the rules are code, and the column exists so each one's output can be
     * counted and audited. See `CITATION_RESOLUTION_RULES`.
     */
    resolutionRuleId: p.varchar("resolution_rule_id", { length: 32 }),
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
    p.index("case_law_citations_citing_page_idx").on(t.citingDecisionId, t.id),
    p
      .index("case_law_citations_cited_page_idx")
      .on(t.citedDecisionId, t.id)
      .where(isNotNull(t.citedDecisionId)),
    p
      .index("case_law_citations_polarity_null_idx")
      .on(t.polarity)
      .where(isNull(t.polarity)),
    // Rule -> citations, for retiring a rule and for its telemetry.
    p
      .index("case_law_citations_polarity_rule_idx")
      .on(t.polarityRuleId)
      .where(isNotNull(t.polarityRuleId)),
    // The burn-down index: the walk's keyset axis, restricted to the rows it
    // still has to examine. Ordered by citing decision because both id
    // families are uuidv7, so walking citations in that order reads the
    // decisions heap in insertion order rather than at random; `id` closes the
    // pair so the keyset is a strict total order and no row is served twice or
    // skipped. It shrinks to nothing as the corpus settles, which the old
    // `cited_decision_id IS NULL` predicate could never do.
    p
      .index("case_law_citations_pending_walk_idx")
      .on(t.citingDecisionId, t.id)
      .where(
        unsettledCitationSql({
          resolutionStatus: t.resolutionStatus,
          citedDecisionId: t.citedDecisionId,
          citationKey: t.citationKey,
        }),
      ),
    // The reverse direction: a decision whose key changes asks which citations
    // that key can now answer differently. Without it that question is a scan
    // of every citation, on the ingestion path, per stored decision.
    p
      .index("case_law_citations_reopenable_key_idx")
      .on(t.citationKey)
      .where(citationReopenableByKeySql(t.resolutionStatus)),
    p
      .index("case_law_citations_reopenable_identifier_idx")
      .on(t.identifierType, t.normalizedIdentifierValue)
      .where(citationReopenableByKeySql(t.resolutionStatus)),
    p
      .index("case_law_citations_identifier_backfill_identity_idx")
      .on(
        effectiveCitationIdentifierTypeSql(t.identifierType),
        effectiveCitationIdentifierValueSql(
          t.normalizedIdentifierValue,
          t.citationKey,
        ),
      )
      .where(settledCitationSql(t.resolutionStatus)),
    p.check(
      "citations_polarity_values",
      sql`${t.polarity} IN (${sql.join(POLARITY_SQL_VALUES, sql.raw(","))})`,
    ),
    p.check(
      "citations_kind_values",
      sql`${t.kind} IN (${sql.join(CITATION_KIND_SQL_VALUES, sql.raw(","))})`,
    ),
    p.check(
      "citations_cited_decision_type_hint_values",
      sql`${t.citedDecisionTypeHint} IN (${sql.join(
        CITATION_DECISION_TYPE_HINT_SQL_VALUES,
        sql.raw(","),
      )})`,
    ),
    p.check(
      "citations_resolution_status_values",
      sql`${t.resolutionStatus} IN (${sql.join(
        CITATION_RESOLUTION_STATUS_SQL_VALUES,
        sql.raw(","),
      )})`,
    ),
    p.check(
      "citations_resolution_rule_id_values",
      sql`${t.resolutionRuleId} IN (${sql.join(
        CITATION_RESOLUTION_RULE_SQL_VALUES,
        sql.raw(","),
      )})`,
    ),
    // The empty string is not a key, it is the absence of one wearing a
    // value's clothes: two rows that both failed to canonicalize would join
    // each other and draw an edge between unrelated cases. Null already means
    // "no key"; this makes the second spelling unrepresentable rather than
    // merely discouraged.
    p.check("citations_citation_key_non_empty", sql`${t.citationKey} <> ''`),
    p.check(
      "citations_identifier_shape",
      sql`(${t.identifierType} IS NULL) = (${t.normalizedIdentifierValue} IS NULL) AND ${t.normalizedIdentifierValue} <> ''`,
    ),
    p.check(
      "citations_identifier_type_values",
      sql`${t.identifierType} IN (${sql.join(DECISION_IDENTIFIER_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    // Authority reads precedent only, so the index covers that arm.
    p
      .index("case_law_citations_precedent_cited_idx")
      .on(t.citedDecisionId)
      .where(sql`${t.kind} = 'precedent' AND ${t.citedDecisionId} IS NOT NULL`),
    ...globalCaseLawPolicies(),
    ...publicCaseLawReaderPolicies(),
  ],
);

export const caseLawProvisionCitations = p.pgTable(
  "case_law_provision_citations",
  {
    id: pUuid<"caseLawProvisionCitation">().primaryKey(),
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    jurisdiction: p.varchar("jurisdiction", { length: 3 }).notNull(),
    workIdentifier: p.text("work_identifier").notNull(),
    workNumber: p.integer("work_number").notNull(),
    workYear: p.smallint("work_year").notNull(),
    workCollection: p.text("work_collection").notNull(),
    workEli: p.text("work_eli"),
    unit: p.text("unit", { enum: PROVISION_UNITS }).notNull(),
    section: p.integer("section").notNull(),
    sectionSuffix: p.text("section_suffix"),
    subsection: p.text("subsection"),
    letter: p.text("letter"),
    point: p.text("point"),
    sentence: p.text("sentence"),
    openEnded: p.boolean("open_ended").default(false).notNull(),
    anchor: p.text("anchor").notNull(),
    versionValidFrom: p.date("version_valid_from"),
    /**
     * The citing decision's date, copied at write time. The provision reads
     * walk newest-first by keyset, so the key lives on the row and in its
     * index rather than on the joined decision.
     */
    decisionDate: p.date("decision_date"),
    sentenceText: p.text("sentence_text").notNull(),
    spanStart: p.integer("span_start").notNull(),
    spanEnd: p.integer("span_end").notNull(),
    workSource: p.text("work_source", { enum: PROVISION_WORK_SOURCES }),
    confidence: p
      .numeric("confidence", { precision: 3, scale: 2, mode: "number" })
      .notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .foreignKey({
        name: "case_law_provision_citations_decision_fk",
        columns: [t.decisionId],
        foreignColumns: [caseLawDecisions.id],
      })
      .onDelete("cascade"),
    p
      .uniqueIndex("case_law_provision_citations_decision_span_idx")
      .on(t.decisionId, t.spanStart, t.anchor),
    p
      .index("case_law_provision_citations_work_idx")
      .on(
        t.jurisdiction,
        t.workIdentifier,
        sql`(coalesce(${t.decisionDate}, '0001-01-01'::date)) DESC`,
        t.decisionId.desc(),
        t.spanStart.desc(),
        t.anchor.desc(),
      ),
    p
      .index("case_law_provision_citations_work_anchor_idx")
      .on(
        t.jurisdiction,
        t.workIdentifier,
        t.anchor,
        sql`(coalesce(${t.decisionDate}, '0001-01-01'::date)) DESC`,
        t.decisionId.desc(),
        t.spanStart.desc(),
      ),
    // The same two walks keyed by the work's identifier instead of its
    // display citation, for a reader arriving from the act itself. Partial:
    // a reference to a work the corpus does not hold carries no ELI, and
    // those rows are never a starting point for this walk.
    p
      .index("case_law_provision_citations_eli_idx")
      .on(
        t.jurisdiction,
        t.workEli,
        sql`(coalesce(${t.decisionDate}, '0001-01-01'::date)) DESC`,
        t.decisionId.desc(),
        t.spanStart.desc(),
        t.anchor.desc(),
      )
      .where(isNotNull(t.workEli)),
    p
      .index("case_law_provision_citations_eli_anchor_idx")
      .on(
        t.jurisdiction,
        t.workEli,
        t.anchor,
        sql`(coalesce(${t.decisionDate}, '0001-01-01'::date)) DESC`,
        t.decisionId.desc(),
        t.spanStart.desc(),
      )
      .where(isNotNull(t.workEli)),
    p.index("case_law_provision_citations_decision_idx").on(t.decisionId),
    p.check(
      "provision_citations_unit_values",
      sql`${t.unit} IN (${sql.join(PROVISION_UNIT_SQL_VALUES, sql.raw(","))})`,
    ),
    p.check(
      "provision_citations_work_source_values",
      sql`${t.workSource} IS NULL OR ${t.workSource} IN (${sql.join(
        PROVISION_WORK_SOURCE_SQL_VALUES,
        sql.raw(","),
      )})`,
    ),
    p.check(
      "provision_citations_span_order",
      sql`${t.spanEnd} > ${t.spanStart}`,
    ),
    p.check(
      "provision_citations_confidence_range",
      sql`${t.confidence} > 0 AND ${t.confidence} <= 1`,
    ),
    ...globalCaseLawPolicies(),
    ...publicCaseLawReaderPolicies(),
  ],
);

/**
 * Where the standing resolution walk had got to.
 *
 * The walk is correct without this: settled rows leave the pending predicate,
 * so a restart from the beginning loses no work. What it loses is time: the
 * left edge of the burn-down index carries entries autovacuum has not
 * reclaimed yet, and every restart re-reads them before reaching live work.
 * Persisting the pair the walk stopped on skips straight past them.
 *
 * A stale cursor can only cost a delay, never a missed row: the walk wraps to
 * the beginning when a batch comes back empty, which is also what picks up
 * rows an arriving decision put back behind the cursor.
 */
export const caseLawCitationResolutionProgress = p.pgTable(
  "case_law_citation_resolution_progress",
  {
    /** One lane today; the column exists so a second can land as a row. */
    scope: p.text({ enum: CITATION_RESOLUTION_SCOPES }).primaryKey(),
    /** The `(citing decision, citation)` pair the last batch stopped on. */
    cursorCitingDecisionId: safeUuid<"caseLawDecision">(
      "cursor_citing_decision_id",
    ),
    cursorCitationId: safeUuid<"caseLawCitation">("cursor_citation_id"),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.check(
      "case_law_citation_resolution_progress_scope_values",
      sql`${t.scope} IN (${sql.join(
        CITATION_RESOLUTION_SCOPE_SQL_VALUES,
        sql.raw(","),
      )})`,
    ),
    // Half a keyset is not a position. Either both columns name where the
    // walk stopped or neither does and it starts from the beginning.
    p.check(
      "case_law_citation_resolution_progress_cursor_pair",
      sql`(${t.cursorCitingDecisionId} IS NULL) = (${t.cursorCitationId} IS NULL)`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

/**
 * One pass of the citation-resolution census: a snapshot of the resolver's
 * populations, taken in bounded steps.
 *
 * The walk over ambiguous keys is keyset-ordered by key and resumes from
 * `cursor_key`, so a run that stops at its per-run bound is continued by the
 * next invocation rather than restarted; `status` says which case a reader
 * is looking at, because a partial count compared with a full one reads as
 * a drop that never happened.
 */
export const caseLawCitationResolutionCensusRuns = p.pgTable(
  "case_law_citation_resolution_census_runs",
  {
    id: pUuid<"caseLawCitationResolutionCensusRun">().primaryKey(),
    status: p.text({ enum: CITATION_CENSUS_RUN_STATUSES }).notNull(),
    startedAt: timestamptz("started_at").defaultNow().notNull(),
    finishedAt: timestamptz("finished_at"),
    /** Ambiguous keys classified so far, over every batch of the run. */
    keysScanned: p.integer("keys_scanned").default(0).notNull(),
    /**
     * Where the baseline walk over precedent citations stands: the last
     * `(citing_decision_id, id)` counted, the resolver's own keyset axis.
     * Null before the first batch.
     */
    cursorCitingDecisionId: safeUuid<"caseLawDecision">(
      "cursor_citing_decision_id",
    ),
    cursorCitationId: safeUuid<"caseLawCitation">("cursor_citation_id"),
    /** The last ambiguous key classified; null before the first batch. */
    cursorKey: p.varchar("cursor_key", { length: 128 }),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p
      .index("case_law_citation_resolution_census_runs_started_idx")
      .on(t.startedAt),
    p.check(
      "case_law_citation_resolution_census_runs_status_values",
      sql`${t.status} IN (${sql.join(
        CITATION_CENSUS_RUN_STATUSES.map((status) => sql`${status}`),
        sql.raw(","),
      )})`,
    ),
    // A finished run is a complete one and a complete run is finished.
    p.check(
      "case_law_citation_resolution_census_runs_finished_pair",
      sql`(${t.finishedAt} IS NULL) = (${t.status} <> 'complete')`,
    ),
    // The baseline keyset is a pair: half of one names no citation.
    p.check(
      "case_law_citation_resolution_census_runs_cursor_pair",
      sql`(${t.cursorCitingDecisionId} IS NULL) = (${t.cursorCitationId} IS NULL)`,
    ),
    // At most one open run, so overlapping invocations share one walk.
    p
      .uniqueIndex("case_law_citation_resolution_census_runs_open_uidx")
      .on(sql`(true)`)
      .where(sql`${t.status} <> 'complete'`),
    ...globalCaseLawPolicies(),
  ],
);

/**
 * One counted population of one run: precedent citations from decisions of
 * (`country`, `court`), split by `kind` into a status, the rule that
 * resolved them, or the shape of an ambiguous key's holders. `keys` is the
 * number of distinct citation keys behind the count and is only meaningful
 * for shapes.
 */
export const caseLawCitationResolutionCensus = p.pgTable(
  "case_law_citation_resolution_census",
  {
    runId: safeUuid<"caseLawCitationResolutionCensusRun">("run_id").notNull(),
    country: p.varchar("country", { length: 3 }).notNull(),
    court: p.text("court").notNull(),
    kind: p.text({ enum: CITATION_CENSUS_ROW_KINDS }).notNull(),
    /** A status, a rule id or a shape, as `kind` says. */
    bucket: p.varchar("bucket", { length: 32 }).notNull(),
    keys: p.integer("keys").default(0).notNull(),
    citations: p.integer("citations").default(0).notNull(),
  },
  (t) => [
    p.primaryKey({
      name: "case_law_citation_resolution_census_pk",
      columns: [t.runId, t.country, t.court, t.kind, t.bucket],
    }),
    // Named by hand: the generated names exceed Postgres's 63-byte limit.
    p
      .foreignKey({
        name: "case_law_citation_resolution_census_run_fk",
        columns: [t.runId],
        foreignColumns: [caseLawCitationResolutionCensusRuns.id],
      })
      .onDelete("cascade"),
    p.check(
      "case_law_citation_resolution_census_kind_values",
      sql`${t.kind} IN (${sql.join(
        CITATION_CENSUS_ROW_KINDS.map((kind) => sql`${kind}`),
        sql.raw(","),
      )})`,
    ),
    // The bucket vocabulary follows the kind; a shape name under `status`
    // or a status under `shape` is a writer bug the table should refuse.
    p.check(
      "case_law_citation_resolution_census_bucket_values",
      sql`(${t.kind} = 'status' AND ${t.bucket} IN (${sql.join(
        CITATION_RESOLUTION_STATUS_SQL_VALUES,
        sql.raw(","),
      )}))
        OR (${t.kind} = 'rule' AND ${t.bucket} IN (${sql.join(
          CITATION_CENSUS_RULE_BUCKETS.map((bucket) => sql`${bucket}`),
          sql.raw(","),
        )}))
        OR (${t.kind} = 'shape' AND ${t.bucket} IN (${sql.join(
          CITATION_AMBIGUITY_SHAPES.map((shape) => sql`${shape}`),
          sql.raw(","),
        )}))`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

export const caseLawPolarityRules = p.pgTable(
  "case_law_polarity_rules",
  {
    id: pUuid<"caseLawPolarityRule">().primaryKey(),
    pattern: p.varchar("pattern", { length: 512 }).notNull(),
    polarity: p.varchar("polarity", { length: 16 }).$type<Polarity>().notNull(),
    language: p.varchar("language", { length: 8 }).notNull(),
    source: p
      .varchar("source", { length: 16 })
      .$type<RuleSource>()
      .notNull()
      .default(RULE_SOURCE.MANUAL),
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
      sql`${t.polarity} IN (${sql.join(POLARITY_SQL_VALUES, sql.raw(","))})`,
    ),
    p.check(
      "polarity_rules_source_values",
      sql`${t.source} IN (${sql.join(RULE_SOURCE_SQL_VALUES, sql.raw(","))})`,
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
// Case Law — Research tables (organization-scoped)
// ---------------------------------------------------------------------------

/**
 * A saved case-law search a member keeps working on. Rows are the public
 * corpus, re-run from `savedQuery` and adjusted by the dispositions below;
 * the table itself stores no decision content. Visible to the whole
 * organization; the owner is recorded for attribution and caps.
 */
export const caseLawResearchTables = p.pgTable(
  "case_law_research_tables",
  {
    id: pUuid<"caseLawResearchTable">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    ownerUserId: p.text("owner_user_id").notNull(),
    name: p.varchar({ length: 256 }).notNull(),
    savedQuery: jsonb("saved_query")
      .$type<CaseLawResearchSavedQuery>()
      .notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p
      .foreignKey({
        name: "case_law_research_tables_organization_id_organization_id_fk",
        columns: [t.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "case_law_research_tables_owner_user_id_user_id_fk",
        columns: [t.ownerUserId],
        foreignColumns: [user.id],
      })
      .onDelete("cascade"),
    // Composite tenant key for the dispositions table, so a child row can
    // never name a table from another organization even on root write paths.
    p.unique("case_law_research_tables_id_org_unq").on(t.id, t.organizationId),
    p
      .index("case_law_research_tables_org_updated_id_idx")
      .on(t.organizationId, t.updatedAt, t.id),
    p.check(
      "case_law_research_tables_saved_query_version_check",
      sql`(jsonb_typeof(${t.savedQuery}) = 'object' AND ${t.savedQuery}->'version' = '1'::jsonb) IS TRUE`,
    ),
    ...orgPolicies(),
  ],
);

const CASE_LAW_RESEARCH_DISPOSITION_SQL_VALUES =
  CASE_LAW_RESEARCH_DISPOSITIONS.map((disposition) =>
    sql.raw(`'${disposition}'`),
  );

/**
 * One decision the table treats differently from its saved query: pinned
 * into the rows whether or not the query still returns it, or excluded from
 * them. `decisionId` carries no foreign key, like the annotations: the corpus
 * may live in a separate public-law database, so the id is validated through
 * the public read gate on write and a decision that has since gone simply
 * yields no row facts.
 */
export const caseLawResearchTableDecisions = p.pgTable(
  "case_law_research_table_decisions",
  {
    tableId: safeUuid<"caseLawResearchTable">("table_id").notNull(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    disposition: p.text({ enum: CASE_LAW_RESEARCH_DISPOSITIONS }).notNull(),
    /** Order among pinned rows; excluded rows carry 0. */
    position: p.integer().notNull().default(0),
    addedBy: p.text("added_by"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    p.primaryKey({
      columns: [t.tableId, t.decisionId],
      name: "case_law_research_table_decisions_pk",
    }),
    p
      .foreignKey({
        name: "clrtd_table_org_fk",
        columns: [t.tableId, t.organizationId],
        foreignColumns: [
          caseLawResearchTables.id,
          caseLawResearchTables.organizationId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "clrtd_added_by_fk",
        columns: [t.addedBy],
        foreignColumns: [user.id],
      })
      .onDelete("set null"),
    p
      .index("clrtd_table_disposition_position_idx")
      .on(t.tableId, t.disposition, t.position),
    p.check(
      "case_law_research_table_decisions_disposition_check",
      sql`${t.disposition} IN (${sql.join(CASE_LAW_RESEARCH_DISPOSITION_SQL_VALUES, sql`, `)})`,
    ),
    ...orgPolicies(),
  ],
);

const CASE_LAW_RESEARCH_ANSWER_TYPE_SQL_VALUES =
  CASE_LAW_RESEARCH_ANSWER_TYPES.map((type) => sql.raw(`'${type}'`));

const CASE_LAW_RESEARCH_ANSWER_STATE_SQL_VALUES =
  CASE_LAW_RESEARCH_ANSWER_STATES.map((state) => sql.raw(`'${state}'`));

/**
 * One question asked of every row of a research table. The answer type fixes
 * what a cell may hold; `tool` is the model configuration the answers were
 * produced with, so a later change can be told apart from a re-run.
 */
export const caseLawResearchColumns = p.pgTable(
  "case_law_research_columns",
  {
    id: pUuid<"caseLawResearchColumn">().primaryKey(),
    tableId: safeUuid<"caseLawResearchTable">("table_id").notNull(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    position: p.integer().notNull(),
    question: p.varchar({ length: 512 }).notNull(),
    answerType: p
      .text("answer_type", { enum: CASE_LAW_RESEARCH_ANSWER_TYPES })
      .notNull(),
    tool: jsonb().$type<CaseLawResearchColumnTool>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p
      .foreignKey({
        name: "clrc_table_org_fk",
        columns: [t.tableId, t.organizationId],
        foreignColumns: [
          caseLawResearchTables.id,
          caseLawResearchTables.organizationId,
        ],
      })
      .onDelete("cascade"),
    // Composite tenant key for the answers table.
    p.unique("case_law_research_columns_id_org_unq").on(t.id, t.organizationId),
    p.index("clrc_table_position_idx").on(t.tableId, t.position),
    p.check(
      "case_law_research_columns_answer_type_check",
      sql`${t.answerType} IN (${sql.join(CASE_LAW_RESEARCH_ANSWER_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    ...orgPolicies(),
  ],
);

/**
 * One cell: a column's answer for one decision. Cached per (column, decision)
 * and recomputed only on an explicit re-run or when the question changes. The
 * state names why a cell has no answer; `decisionId` carries no foreign key
 * for the same reason the dispositions table does not.
 */
export const caseLawResearchAnswers = p.pgTable(
  "case_law_research_answers",
  {
    columnId: safeUuid<"caseLawResearchColumn">("column_id").notNull(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    state: p.text({ enum: CASE_LAW_RESEARCH_ANSWER_STATES }).notNull(),
    answer: jsonb().$type<CaseLawResearchAnswerValue>(),
    confidence: p.doublePrecision(),
    run: jsonb().$type<CaseLawResearchAnswerRun>(),
    /** A short reason class for `failed`; never the provider's message. */
    failureReason: p.varchar("failure_reason", { length: 64 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    p.primaryKey({
      columns: [t.columnId, t.decisionId],
      name: "case_law_research_answers_pk",
    }),
    p
      .foreignKey({
        name: "clra_column_org_fk",
        columns: [t.columnId, t.organizationId],
        foreignColumns: [
          caseLawResearchColumns.id,
          caseLawResearchColumns.organizationId,
        ],
      })
      .onDelete("cascade"),
    p.index("clra_column_state_idx").on(t.columnId, t.state),
    p.check(
      "case_law_research_answers_state_check",
      sql`${t.state} IN (${sql.join(CASE_LAW_RESEARCH_ANSWER_STATE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "case_law_research_answers_confidence_check",
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
    // An answered cell carries its answer; every other state carries none.
    p.check(
      "case_law_research_answers_answer_state_check",
      sql`(${t.state} = 'answered') = (${t.answer} IS NOT NULL)`,
    ),
    ...orgPolicies(),
  ],
);

// ---------------------------------------------------------------------------
// Case Law — Search index (global, no tenant column)
// ---------------------------------------------------------------------------

/** What a reader leaves on a decision's text. */
export const CASE_LAW_ANNOTATION_KINDS = ["highlight", "comment"] as const;
export type CaseLawAnnotationKind = (typeof CASE_LAW_ANNOTATION_KINDS)[number];

/** Who besides the author sees an annotation. */
export const CASE_LAW_ANNOTATION_VISIBILITIES = ["private", "shared"] as const;
export type CaseLawAnnotationVisibility =
  (typeof CASE_LAW_ANNOTATION_VISIBILITIES)[number];

/** Highlight swatches, named after the design system's option palette. */
export const CASE_LAW_ANNOTATION_COLORS = [
  "yellow",
  "green",
  "sky",
  "violet",
  "red",
] as const;
export type CaseLawAnnotationColor =
  (typeof CASE_LAW_ANNOTATION_COLORS)[number];

/** How a highlight is drawn, the way a PDF reader offers mark-up styles. */
export const CASE_LAW_ANNOTATION_STYLES = [
  "highlight",
  "underline",
  "squiggly",
  "strikethrough",
] as const;
export type CaseLawAnnotationStyle =
  (typeof CASE_LAW_ANNOTATION_STYLES)[number];

const CASE_LAW_ANNOTATION_KIND_SQL_VALUES = CASE_LAW_ANNOTATION_KINDS.map(
  (value) => sql.raw(`'${value}'`),
);
const CASE_LAW_ANNOTATION_VISIBILITY_SQL_VALUES =
  CASE_LAW_ANNOTATION_VISIBILITIES.map((value) => sql.raw(`'${value}'`));
const CASE_LAW_ANNOTATION_COLOR_SQL_VALUES = CASE_LAW_ANNOTATION_COLORS.map(
  (value) => sql.raw(`'${value}'`),
);
const CASE_LAW_ANNOTATION_STYLE_SQL_VALUES = CASE_LAW_ANNOTATION_STYLES.map(
  (value) => sql.raw(`'${value}'`),
);

/** Long enough for a paragraph a reader marks, short enough to stay a quote. */
export const CASE_LAW_ANNOTATION_QUOTE_MAX_LENGTH = 2000;
export const CASE_LAW_ANNOTATION_BODY_MAX_LENGTH = 10_000;

/**
 * A reader's highlights and comments on a decision. Organization-owned,
 * author-controlled: private by default, visible to the organization once
 * shared, and only ever edited by its author (`authoredNotePolicies`).
 *
 * The decision is referenced by id without a foreign key: the public-law
 * corpus may live in another database (`PUBLIC_LAW_DATABASE_URL`), and a
 * decision withdrawn from the corpus leaves its notes behind rather than
 * deleting a reader's own words.
 *
 * The anchor is the block's stable anchor plus offsets into its rendered
 * text and the quoted text itself, so a re-parse that moves offsets can
 * still find the words.
 */
export const caseLawDecisionAnnotations = p.pgTable(
  "case_law_decision_annotations",
  {
    id: pUuid<"caseLawDecisionAnnotation">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    userId: p.text("user_id").notNull(),
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    /**
     * Ties the rows of one mark that spans several paragraphs; null for a
     * mark inside one. A change to the mark reaches every row of the group.
     */
    groupId: p.uuid("group_id"),
    kind: p.text("kind", { enum: CASE_LAW_ANNOTATION_KINDS }).notNull(),
    visibility: p
      .text("visibility", { enum: CASE_LAW_ANNOTATION_VISIBILITIES })
      .notNull()
      .default("private"),
    color: p.text("color", { enum: CASE_LAW_ANNOTATION_COLORS }),
    style: p.text("style", { enum: CASE_LAW_ANNOTATION_STYLES }),
    blockAnchorId: p.varchar("block_anchor_id", { length: 64 }).notNull(),
    startOffset: p.integer("start_offset").notNull(),
    endOffset: p.integer("end_offset").notNull(),
    quote: p
      .varchar({ length: CASE_LAW_ANNOTATION_QUOTE_MAX_LENGTH })
      .notNull(),
    body: p.varchar({ length: CASE_LAW_ANNOTATION_BODY_MAX_LENGTH }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .foreignKey({
        name: "case_law_decision_annotations_organization_id_fk",
        columns: [t.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "case_law_decision_annotations_user_id_fk",
        columns: [t.userId],
        foreignColumns: [user.id],
      })
      .onDelete("cascade"),
    p
      .index("case_law_decision_annotations_decision_idx")
      .on(t.organizationId, t.decisionId, t.createdAt, t.id),
    p
      .index("case_law_decision_annotations_group_idx")
      .on(t.organizationId, t.groupId)
      .where(isNotNull(t.groupId)),
    p.check(
      "case_law_decision_annotations_kind_values",
      sql`${t.kind} IN (${sql.join(CASE_LAW_ANNOTATION_KIND_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "case_law_decision_annotations_visibility_values",
      sql`${t.visibility} IN (${sql.join(CASE_LAW_ANNOTATION_VISIBILITY_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "case_law_decision_annotations_color_values",
      sql`${t.color} IS NULL OR ${t.color} IN (${sql.join(CASE_LAW_ANNOTATION_COLOR_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "case_law_decision_annotations_style_values",
      sql`${t.style} IS NULL OR ${t.style} IN (${sql.join(CASE_LAW_ANNOTATION_STYLE_SQL_VALUES, sql`, `)})`,
    ),
    // A highlight is a colour and a style on the text; a comment is words,
    // carried by its first row when the passage spans paragraphs.
    p.check(
      "case_law_decision_annotations_kind_shape",
      sql`(${t.kind} = 'highlight' AND ${t.color} IS NOT NULL AND ${t.style} IS NOT NULL AND ${t.body} IS NULL)
        OR (${t.kind} = 'comment' AND ${t.style} IS NULL AND ((${t.body} IS NOT NULL AND ${t.body} <> '') OR ${t.groupId} IS NOT NULL))`,
    ),
    p.check(
      "case_law_decision_annotations_span_shape",
      sql`${t.startOffset} >= 0 AND ${t.endOffset} > ${t.startOffset} AND ${t.quote} <> ''`,
    ),
    ...authoredNotePolicies(),
  ],
);

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
    generation: p.varchar({ length: 64 }).notNull(),
    operation: p
      .varchar({ length: 16 })
      .notNull()
      .$type<CorpusIndexJobOperation>(),
    status: p.varchar({ length: 16 }).notNull().$type<CorpusIndexJobStatus>(),
    contentHash: p.varchar("content_hash", { length: 64 }),
    errorMessage: p.varchar("error_message", { length: 2048 }),
    /**
     * Why a succeeded operation was performed, in the caller's own words.
     * Separate from `error_message`, which a reader takes as the failure of
     * the row it sits on: a withdrawal's reason filed there reads as an
     * operation that failed, which it did not.
     */
    detail: p.varchar("detail", { length: 2048 }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.index("case_law_index_jobs_decision_idx").on(t.decisionId),
    p.index("case_law_index_jobs_created_idx").on(t.createdAt),
    p
      .index("case_law_index_jobs_redaction_decision_idx")
      .on(t.decisionId, t.createdAt.desc())
      .where(sql`${t.operation} = 'redact' AND ${t.decisionId} IS NOT NULL`),
    p.check(
      "case_law_index_jobs_operation_values",
      sql`${t.operation} IN (${sql.join(CORPUS_INDEX_JOB_OPERATION_SQL_VALUES, sql.raw(","))})`,
    ),
    p.check(
      "case_law_index_jobs_status_values",
      sql`${t.status} IN (${sql.join(CORPUS_INDEX_JOB_STATUS_SQL_VALUES, sql.raw(","))})`,
    ),
    // A row that succeeded carries no failure; its reason belongs in `detail`.
    // The reverse is open on purpose: a failed row may record both what it was
    // for and what went wrong.
    p.check(
      CORPUS_INDEX_JOB_SUCCEEDED_CHECKS.case_law_index_jobs,
      sql`${t.status} <> ${CORPUS_INDEX_JOB_SUCCEEDED_SQL_VALUE} OR ${t.errorMessage} IS NULL`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

/**
 * Highest Quickwit delete task durably observed for each physical case-law
 * index. One row replaces an unbounded scan of the engine's task history:
 * settlement means every published split has reached this opstamp.
 */
export const caseLawCorpusIndexDeleteWatermarks = p.pgTable(
  "case_law_corpus_index_delete_watermarks",
  {
    indexId: p.varchar("index_id", { length: 64 }).primaryKey(),
    opstamp: p.bigint({ mode: "number" }).notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    p.check(
      "case_law_corpus_index_delete_watermarks_nonnegative",
      sql`${t.opstamp} >= 0`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

/**
 * Documents whose accepted Quickwit delete task has not been observed on
 * every published split. The composite key makes task replay idempotent;
 * census removes a row only after the split watermark reaches its opstamp.
 */
export const caseLawCorpusIndexPendingDeletes = p.pgTable(
  "case_law_corpus_index_pending_deletes",
  {
    indexId: p.varchar("index_id", { length: 64 }).notNull(),
    // No foreign key: a source deletion must not erase settlement ownership
    // before the engine has removed the decision from every published split.
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    opstamp: p.bigint({ mode: "number" }).notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      name: "case_law_corpus_index_pending_deletes_pkey",
      columns: [t.indexId, t.decisionId],
    }),
    p
      .index("case_law_corpus_index_pending_deletes_settlement_idx")
      .on(t.indexId, t.opstamp),
    p.check(
      "case_law_corpus_index_pending_deletes_nonnegative",
      sql`${t.opstamp} >= 0`,
    ),
    ...caseLawIngestionOnlyPolicies(),
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
    generationOrder: p
      .integer("generation_order")
      .notNull()
      .generatedAlwaysAs(
        sql`substring("generation" from '^case_law_v([1-9][0-9]*)$')::integer`,
      ),
    snapshotAt: timestamptz("snapshot_at").defaultNow().notNull(),
    /**
     * The walk's previous, creation-ordered cursor. Nothing reads or writes it:
     * it stays only because a migration runs before the tasks of the release
     * that stops selecting it have finished rolling out, and a dropped column
     * would fail their checkpoint read. Drop it in the release after
     * `cursor_walk_date` ships.
     */
    cursorCreatedAt: timestamptz("cursor_created_at"),
    /**
     * Keyset position in the walk's own order: the decision date the last
     * indexed page ended on, `-infinity` while the walk is still in the undated
     * band. Paired with `cursor_id`, which carries the ties a day-granular date
     * leaves behind.
     */
    cursorWalkDate: p.date("cursor_walk_date"),
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
      sql`(${t.cursorWalkDate} IS NULL) = (${t.cursorId} IS NULL)`,
    ),
    p.check(
      "case_law_corpus_index_backfills_lease_pair",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseExpiresAt} IS NULL)`,
    ),
    p
      .index("case_law_corpus_index_backfills_order_generation_idx")
      .on(t.generationOrder, t.generation),
    ...globalCaseLawPolicies(),
  ],
);

/**
 * Durable, bounded work created when a source's corpus eligibility changes.
 * A new revision resets the decision cursor, so a racing worker cannot advance
 * over or delete newer eligibility work.
 */
export const caseLawCorpusIndexSourceReconciliations = p.pgTable(
  "case_law_corpus_index_source_reconciliations",
  {
    generation: p.varchar({ length: 32 }).notNull(),
    sourceId: safeUuid<"caseLawSource">("source_id").notNull(),
    revision: p.integer().default(1).notNull(),
    cursorCreatedAt: timestamptz("cursor_created_at"),
    cursorId: safeUuid<"caseLawDecision">("cursor_id"),
    upperCreatedAt: timestamptz("upper_created_at"),
    upperId: safeUuid<"caseLawDecision">("upper_id"),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      columns: [t.generation, t.sourceId],
      name: "case_law_corpus_index_source_reconciliations_pk",
    }),
    p
      .foreignKey({
        name: "case_law_corpus_index_source_reconciliations_generation_fk",
        columns: [t.generation],
        foreignColumns: [caseLawCorpusIndexBackfills.generation],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "case_law_corpus_index_source_reconciliations_source_fk",
        columns: [t.sourceId],
        foreignColumns: [caseLawSources.id],
      })
      .onDelete("cascade"),
    p.check(
      "case_law_corpus_index_source_reconciliations_cursor_pair",
      sql`(${t.cursorCreatedAt} IS NULL) = (${t.cursorId} IS NULL)`,
    ),
    p.check(
      "case_law_corpus_index_source_reconciliations_upper_pair",
      sql`(${t.upperCreatedAt} IS NULL) = (${t.upperId} IS NULL)`,
    ),
    p.check(
      "case_law_source_reconciliations_cursor_upper",
      sql`${t.cursorCreatedAt} IS NULL OR (${t.upperCreatedAt} IS NOT NULL AND (${t.cursorCreatedAt}, ${t.cursorId}) <= (${t.upperCreatedAt}, ${t.upperId}))`,
    ),
    p
      .index("case_law_corpus_index_source_reconciliations_source_idx")
      .on(t.sourceId),
    ...globalCaseLawPolicies(),
  ],
);

/** Mutual exclusion for every writer targeting one physical generation. */
export const caseLawCorpusIndexWriterLeases = p.pgTable(
  "case_law_corpus_index_writer_leases",
  {
    generation: p.varchar({ length: 32 }).primaryKey(),
    leaseToken: p.uuid("lease_token"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.check(
      "case_law_corpus_index_writer_leases_pair",
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
    pendingIndexIds: p
      .varchar("pending_index_ids", { length: 64 })
      .array()
      .notNull()
      .default(sql`'{}'::varchar(64)[]`),
    pendingRevision: p.integer("pending_revision").default(0).notNull(),
    /**
     * Physical index whose membership is reflected in the exact aggregate.
     * A database trigger derives this from the same current-decision and
     * committed-projection state accepted by the serving query; null means
     * this row contributes no document to the aggregate.
     */
    accountedIndexId: p.varchar("accounted_index_id", { length: 64 }),
    /**
     * When a reservation last crossed the external append boundary. Only the
     * append reservation sets it — the projection trigger never does — so
     * its absence, with no committed copy, proves nothing has reached the
     * engine for this row and the backfill can append without a delete.
     */
    appendReservedAt: timestamptz("append_reserved_at"),
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
      sql`((${t.pendingAction} IS NULL AND ${t.pendingHash} IS NULL AND cardinality(${t.pendingIndexIds}) = 0)
        OR (${t.pendingAction} = 'index' AND ${t.pendingHash} IS NOT NULL AND cardinality(${t.pendingIndexIds}) > 0)
        OR (${t.pendingAction} = 'delete' AND ${t.pendingHash} IS NULL)) IS TRUE`,
    ),
    p.check(
      "case_law_corpus_index_projections_pending_revision_nonnegative",
      sql`${t.pendingRevision} >= 0`,
    ),
    p.check(
      "case_law_corpus_index_projections_accounted_shape",
      sql`${t.accountedIndexId} IS NULL OR (${t.pendingAction} IS NULL AND ${t.indexedHash} IS NOT NULL AND ${t.accountedIndexId} = ${t.indexId})`,
    ),
    p.index("case_law_corpus_index_projections_decision_idx").on(t.decisionId),
    p
      .index("case_law_corpus_index_projections_pending_idx")
      .on(t.generation, t.decisionId)
      .where(isNotNull(t.pendingAction)),
    ...globalCaseLawPolicies(),
    ...publicCaseLawReaderPolicies(),
  ],
);

export const CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUSES = [
  "running",
  "complete",
] as const;

export type CaseLawCorpusIndexCountBackfillStatus =
  (typeof CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUSES)[number];

export const CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS = {
  RUNNING: CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUSES[0],
  COMPLETE: CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUSES[1],
} as const satisfies Record<string, CaseLawCorpusIndexCountBackfillStatus>;

/** Exact, transactionally maintained document count per physical index. */
export const caseLawCorpusIndexCounts = p.pgTable(
  "case_law_corpus_index_counts",
  {
    generation: p.varchar({ length: 32 }).notNull(),
    indexId: p.varchar("index_id", { length: 64 }).notNull(),
    markedIndexed: p
      .bigint("marked_indexed", { mode: "number" })
      .default(0)
      .notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      columns: [t.generation, t.indexId],
      name: "case_law_corpus_index_counts_pk",
    }),
    p
      .foreignKey({
        name: "case_law_corpus_index_counts_generation_fk",
        columns: [t.generation],
        foreignColumns: [caseLawCorpusIndexBackfills.generation],
      })
      .onDelete("cascade"),
    p.check(
      "case_law_corpus_index_counts_nonnegative",
      sql`${t.markedIndexed} >= 0`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

/** Durable keyset progress for accounting projections created before rollout. */
export const caseLawCorpusIndexCountBackfills = p.pgTable(
  "case_law_corpus_index_count_backfills",
  {
    generation: p.varchar({ length: 32 }).primaryKey(),
    cursorDecisionId: safeUuid<"caseLawDecision">("cursor_decision_id"),
    status: p
      .text({ enum: CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUSES })
      .notNull()
      .default(CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.RUNNING),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .foreignKey({
        name: "case_law_corpus_index_count_backfills_generation_fk",
        columns: [t.generation],
        foreignColumns: [caseLawCorpusIndexBackfills.generation],
      })
      .onDelete("cascade"),
    p.check(
      "case_law_corpus_index_count_backfills_status_values",
      sql`${t.status} IN (${sql.join(
        CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUSES.map((status) =>
          sql.raw(`'${status}'`),
        ),
        sql.raw(","),
      )})`,
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
