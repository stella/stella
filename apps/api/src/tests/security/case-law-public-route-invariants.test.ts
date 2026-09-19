import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import type { ScopedDb } from "@/api/db/safe-db";
import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";
import { isSafePublicHandler } from "@/api/lib/api-handlers";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { corpusIndexReadContract } from "@/api/lib/legal-search/corpus-index-read-contract";
import {
  apiSourceRoot,
  collectApiModuleGraph,
} from "@/api/tests/api-module-graph";

type ScopedDbIsPublicReadDb = ScopedDb extends CaseLawPublicReadDb
  ? true
  : false;

// @ts-expect-error ScopedDb must not satisfy the branded public-read boundary.
const scopedDbIsPublicReadDb: ScopedDbIsPublicReadDb = true;
void scopedDbIsPublicReadDb;

const ROUTES_FILE = "apps/api/src/handlers/case-law/public-routes.ts";
const LIST_DECISIONS_FILE = "apps/api/src/handlers/case-law/decisions/list.ts";
const READ_DECISION_FILE = "apps/api/src/handlers/case-law/decisions/get.ts";
const PUBLIC_SUBJECT_FILE = "apps/api/src/lib/case-law/public-subject.ts";
const DEFERRED_DOCUMENT_FILE =
  "apps/api/src/handlers/case-law/decisions/get-deferred-document.ts";
const FACETS_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/decisions/facets.ts";
const PG_FTS_FACETS_FILE =
  "apps/api/src/lib/legal-search/pg-fts-browse-facets.ts";
const CORPUS_INDEX_FACETS_FILE =
  "apps/api/src/lib/legal-search/corpus-index-facets.ts";
const CORPUS_INDEX_PROJECTION_INPUT_FILE =
  "apps/api/src/lib/legal-search/corpus-index-projection-desired-state.ts";
const CORPUS_INDEX_PROJECTION_DESCRIPTOR_FILE =
  "apps/api/src/lib/legal-search/corpus-index-projection-descriptor.ts";
const BROWSE_FACETS_CACHE_FILE =
  "apps/api/src/lib/legal-search/browse-facets-cache.ts";
const NON_REDISTRIBUTABLE_SOURCES_FILE =
  "apps/api/src/lib/case-law/non-redistributable-sources.ts";
const SEARCH_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/decisions/search.ts";
const SEARCH_DECISIONS_SCHEMA_FILE =
  "apps/api/src/handlers/case-law/decisions/search-schema.ts";
const LATEST_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/decisions/latest.ts";
const STATUS_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/decisions/status.ts";
const COVERAGE_ARRIVALS_FILE =
  "apps/api/src/handlers/case-law/decisions/coverage-arrivals.ts";
const COVERAGE_FILE = "apps/api/src/handlers/case-law/decisions/coverage.ts";
const CITATION_GRAPH_FILE =
  "apps/api/src/handlers/case-law/decisions/citation-graph.ts";
const LANGUAGE_ALTERNATES_FILE =
  "apps/api/src/lib/case-law/language-alternates.ts";
const SITEMAP_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/decisions/sitemap.ts";
const PUBLIC_READ_DB_FILE = "apps/api/src/lib/public-law-read-db.ts";
const DECISION_PROVISIONS_FILE =
  "apps/api/src/handlers/case-law/provisions/list-for-decision.ts";
const CITING_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/provisions/citing-decisions.ts";
const LAUNCH_READINESS_FILE =
  "packages/api-contract/src/case-law-launch-readiness.ts";
const RESEARCH_SUGGEST_PROMPT_FILE =
  "apps/api/src/handlers/case-law/research/columns-suggest-prompt.ts";
const CITATION_AUTHORITY_FILE =
  "apps/api/src/handlers/case-law/citation-authority.ts";

/**
 * Every route this slice mounts, sorted.
 *
 * The factory census below filters Elysia's internal entries out before it
 * asks which handlers carry the stamp. Pinning the surviving set here is what
 * stops that filter from excusing the census: a filter that dropped real
 * routes, or a route that quietly disappeared, fails this list rather than
 * passing an empty check.
 */
const PUBLIC_CASE_LAW_ROUTES = [
  "GET /case/coverage",
  "GET /case/decisions",
  "GET /case/decisions/:decisionId",
  "GET /case/decisions/:decisionId/citations",
  "GET /case/decisions/:decisionId/citations/leading",
  "GET /case/decisions/:decisionId/citations/summary",
  "GET /case/decisions/:decisionId/provisions",
  "GET /case/decisions/by-slug/:slug",
  "GET /case/decisions/facets",
  "GET /case/decisions/latest",
  "GET /case/decisions/status",
  "GET /case/judges/:judgeId/portrait",
  "GET /case/provisions/citation-counts",
  "GET /case/provisions/citing-decisions",
  "GET /case/sitemap/decisions/shard",
  "GET /case/sitemap/shards",
  "POST /case/decisions/search",
] as const;

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
const readSource = async (path: string) =>
  await Bun.file(nodePath.resolve(repoRoot, path)).text();

const readRoutesSource = async () => await readSource(ROUTES_FILE);
const readListSource = async () => await readSource(LIST_DECISIONS_FILE);
const readDecisionSource = async () => await readSource(READ_DECISION_FILE);
const readPublicSubjectSource = async () =>
  await readSource(PUBLIC_SUBJECT_FILE);
const readDeferredDocumentSource = async () =>
  await readSource(DEFERRED_DOCUMENT_FILE);
const readFacetsSource = async () => await readSource(FACETS_DECISIONS_FILE);
const readPgFtsFacetsSource = async () => await readSource(PG_FTS_FACETS_FILE);
const readCorpusIndexFacetsSource = async () =>
  await readSource(CORPUS_INDEX_FACETS_FILE);
const readCorpusIndexProjectionInputSource = async () =>
  await readSource(CORPUS_INDEX_PROJECTION_INPUT_FILE);
const readCorpusIndexProjectionDescriptorSource = async () =>
  await readSource(CORPUS_INDEX_PROJECTION_DESCRIPTOR_FILE);
const readBrowseFacetsCacheSource = async () =>
  await readSource(BROWSE_FACETS_CACHE_FILE);
const readNonRedistributableSourcesSource = async () =>
  await readSource(NON_REDISTRIBUTABLE_SOURCES_FILE);
const readSearchSource = async () => await readSource(SEARCH_DECISIONS_FILE);
const readSearchSchemaSource = async () =>
  await readSource(SEARCH_DECISIONS_SCHEMA_FILE);
const readLanguageAlternatesSource = async () =>
  await readSource(LANGUAGE_ALTERNATES_FILE);
const readSitemapSource = async () => await readSource(SITEMAP_DECISIONS_FILE);
const readPublicReadDbSource = async () =>
  await readSource(PUBLIC_READ_DB_FILE);

/**
 * How a module in the public read surface answers for listing-only rows.
 *
 * A listing-only decision (guide rule 20) is a listed identity whose detail
 * never arrived: durable, and unpublished until it does. Excluding it is not a
 * thing each new read can be trusted to remember, so the census below derives
 * the surface from the route module's own import graph and requires a written
 * answer for every module in it that names the decision table.
 */
const PUBLIC_DECISION_READ_GATE = {
  /** Carries the shared predicate, in one of its three spellings. */
  PREDICATE: "carries-the-predicate",
  /** Reads through a `RedistributableDecisionSubject`, which the gate mints. */
  SUBJECT: "gated-by-the-subject-factory",
  /** Names the table without reading a decision row out of it. */
  NO_ROW_READ: "reads-no-decision-row",
  /**
   * Counts rows, listing-only ones included, and returns only the count.
   *
   * The publication gate keeps a listed identity whose document never arrived
   * out of every surface that would show it. A completeness figure is the one
   * public statement that has to include it: the denominator is what the
   * publisher says it holds, and a publisher counts every document it lists,
   * so a numerator that dropped those rows would report a corpus as short of
   * the publisher by exactly the rows the publisher would not serve. What
   * leaves the process is an integer, never an identity.
   *
   * An entry needs a written reason, as `NO_ROW_READ` does, and the census
   * below checks that both kinds carry one.
   */
  COUNTS_STORED: "counts-stored-rows-only",
} as const;

type PublicDecisionReadEntry =
  | { gate: typeof PUBLIC_DECISION_READ_GATE.PREDICATE }
  | { gate: typeof PUBLIC_DECISION_READ_GATE.SUBJECT }
  | { gate: typeof PUBLIC_DECISION_READ_GATE.NO_ROW_READ; reason: string }
  | { gate: typeof PUBLIC_DECISION_READ_GATE.COUNTS_STORED; reason: string };

/** The spellings of the one predicate, plus the marker reader the projection uses. */
const PUBLIC_DECISION_PREDICATE_TOKENS = [
  "publishedCaseLawDecision",
  "publicCaseLawDecisionJoin",
  "partialObservationFromMetadata",
] as const;

const DECISION_TABLE_MENTION = /caseLawDecisions|case_law_decisions/u;

const PUBLIC_DECISION_READ_GATES = {
  "apps/api/src/db/rls.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "Declares the roles and policies; issues no query.",
  },
  "apps/api/src/db/schema/case-law.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "Table definition.",
  },
  "apps/api/src/db/schema/legislation.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "Table definition; references the decision table by name only.",
  },
  "apps/api/src/db/schema/relations.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "Relation definitions.",
  },
  [COVERAGE_ARRIVALS_FILE]: { gate: PUBLIC_DECISION_READ_GATE.PREDICATE },
  [CITATION_GRAPH_FILE]: { gate: PUBLIC_DECISION_READ_GATE.PREDICATE },
  "apps/api/src/handlers/case-law/decisions/citations.ts": {
    gate: PUBLIC_DECISION_READ_GATE.PREDICATE,
  },
  [READ_DECISION_FILE]: { gate: PUBLIC_DECISION_READ_GATE.SUBJECT },
  [LATEST_DECISIONS_FILE]: { gate: PUBLIC_DECISION_READ_GATE.PREDICATE },
  [LIST_DECISIONS_FILE]: { gate: PUBLIC_DECISION_READ_GATE.PREDICATE },
  [PUBLIC_SUBJECT_FILE]: { gate: PUBLIC_DECISION_READ_GATE.PREDICATE },
  [SEARCH_DECISIONS_FILE]: { gate: PUBLIC_DECISION_READ_GATE.PREDICATE },
  "apps/api/src/handlers/case-law/decisions/shelf-courts.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason:
      "Walks distinct court names. The shelf's rows come from the latest " +
      "handler, which carries the predicate, so a court whose only rows are " +
      "listing-only contributes none and is dropped.",
  },
  [SITEMAP_DECISIONS_FILE]: { gate: PUBLIC_DECISION_READ_GATE.PREDICATE },
  "apps/api/src/handlers/case-law/decisions/status-courts.ts": {
    gate: PUBLIC_DECISION_READ_GATE.PREDICATE,
  },
  [STATUS_DECISIONS_FILE]: { gate: PUBLIC_DECISION_READ_GATE.PREDICATE },
  [CITING_DECISIONS_FILE]: { gate: PUBLIC_DECISION_READ_GATE.PREDICATE },
  "apps/api/src/handlers/case-law/provisions/previews-for-decision.ts": {
    gate: PUBLIC_DECISION_READ_GATE.SUBJECT,
  },
  "apps/api/src/handlers/case-law/stored-payload.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "SQL fragments for 'this row holds a document'; no query.",
  },
  "apps/api/src/lib/case-law-public-read-db.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "The read handle the gated reads run through.",
  },
  "apps/api/src/lib/case-law/decision-row-columns.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "The column list a public row is selected with; no query.",
  },
  [LANGUAGE_ALTERNATES_FILE]: { gate: PUBLIC_DECISION_READ_GATE.PREDICATE },
  "apps/api/src/lib/case-law/published-decisions.ts": {
    gate: PUBLIC_DECISION_READ_GATE.PREDICATE,
  },
  "apps/api/src/lib/case-law/search-candidate-row-bound-sql.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "The candidate index's byte budget as a CHECK fragment; no query.",
  },
  "apps/api/src/lib/case-law/search-sql.ts": {
    gate: PUBLIC_DECISION_READ_GATE.PREDICATE,
  },
  "apps/api/src/lib/decision-date-bounds-sql.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "Date-bound fragments; no query.",
  },
  "apps/api/src/lib/legal-search/case-law-corpus-projection.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "Index-id and projection-state fragments; no row read.",
  },
  "apps/api/src/lib/legal-search/case-law-corpus-upload-intents.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "Ingestion-side mirror upload intents; not a public read.",
  },
  "apps/api/src/lib/legal-search/case-law-search-index.ts": {
    gate: PUBLIC_DECISION_READ_GATE.PREDICATE,
  },
  [CORPUS_INDEX_PROJECTION_INPUT_FILE]: {
    gate: PUBLIC_DECISION_READ_GATE.PREDICATE,
  },
  "apps/api/src/lib/legal-search/corpus-index-provider.ts": {
    gate: PUBLIC_DECISION_READ_GATE.PREDICATE,
  },
  "apps/api/src/lib/legal-search/document-context.ts": {
    gate: PUBLIC_DECISION_READ_GATE.PREDICATE,
  },
  "apps/api/src/lib/legal-search/partial-observation-sql.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason:
      "States the listing-only predicate the readers and the index share; issues no query.",
  },
  [PG_FTS_FACETS_FILE]: { gate: PUBLIC_DECISION_READ_GATE.PREDICATE },
  "apps/api/src/lib/legal-search/pg-fts-legal-provider.ts": {
    gate: PUBLIC_DECISION_READ_GATE.PREDICATE,
  },
  "apps/api/src/lib/legal-search/sk-document-backfill.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "Ingestion backfill of Slovak documents; not a public read.",
  },
  [PUBLIC_READ_DB_FILE]: {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "The public reader's connection and its per-transaction guards.",
  },
  "apps/api/src/lib/public-law-relations.ts": {
    gate: PUBLIC_DECISION_READ_GATE.NO_ROW_READ,
    reason: "The columns the reader role is granted; no query.",
  },
} as const satisfies Record<string, PublicDecisionReadEntry>;

const publicRouteBlock = (source: string): string => {
  const start = source.indexOf("export const publicCaseLawRoute");

  expect(start).toBeGreaterThanOrEqual(0);

  return source.slice(start);
};

describe("public case-law route boundary", () => {
  test("public case-law API is dark-launched outside local development", async () => {
    const source = await readRoutesSource();

    expect(source).toContain("env.isDev || env.FEATURE_PUBLIC_LAW");
    expect(source).toContain("set.status = 404");
  });

  test("public read transaction cannot mutate data", () => {
    type PublicTxHasInsert = "insert" extends keyof CaseLawPublicReadTransaction
      ? true
      : false;
    type PublicTxHasUpdate = "update" extends keyof CaseLawPublicReadTransaction
      ? true
      : false;
    type PublicTxHasDelete = "delete" extends keyof CaseLawPublicReadTransaction
      ? true
      : false;

    const publicTxHasInsert: PublicTxHasInsert = false;
    const publicTxHasUpdate: PublicTxHasUpdate = false;
    const publicTxHasDelete: PublicTxHasDelete = false;

    expect(publicTxHasInsert).toBe(false);
    expect(publicTxHasUpdate).toBe(false);
    expect(publicTxHasDelete).toBe(false);
  });

  test("public read database transactions are read-only at runtime", async () => {
    const source = await readPublicReadDbSource();

    expect(source).toContain('["transaction_read_only", "on"]');
    expect(source).toContain(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
  });

  test("external role validation is bounded and retries after failure", async () => {
    const source = await readPublicReadDbSource();
    const guards = source.slice(
      source.indexOf("const PUBLIC_LAW_READ_GUARDS"),
      source.indexOf("const localSettings"),
    );
    const readConfiguration = source.slice(
      source.indexOf("const configureReadTransaction"),
      source.indexOf("const publicLawReadGuards"),
    );
    const validation = source.slice(
      source.indexOf("const startRoleValidation"),
      source.indexOf("const ensureRoleValidated"),
    );

    expect(source).toContain(
      "connectionTimeout: EXTERNAL_PUBLIC_LAW_CONNECTION_TIMEOUT_SECONDS",
    );
    expect(validation).toContain(".transaction(async (tx) =>");
    expect(guards).toContain('["statement_timeout", "30s"]');
    expect(guards).toContain('["lock_timeout", "1s"]');
    expect(guards).toContain('["idle_in_transaction_session_timeout", "30s"]');
    expect(readConfiguration).toContain(
      "await tx.execute(localSettings(guards))",
    );
    expect(validation.indexOf("configureReadTransaction(")).toBeLessThan(
      validation.indexOf("validateExternalPublicLawDatabase(tx)"),
    );
    expect(validation).toContain(
      'external.roleValidation = { status: "idle" }',
    );
  });

  test("shared-corpus reads cannot start document ingestion", async () => {
    const source = await readDeferredDocumentSource();
    const guard = source.indexOf(
      "envBase.PUBLIC_LAW_DATABASE_URL !== undefined",
    );
    const ingestionCall = source.indexOf("readThroughDeferredDocument({");

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(ingestionCall).toBeGreaterThan(guard);
  });

  test("public read transaction only exposes case-law relational queries", () => {
    type PublicQueryKeys = keyof CaseLawPublicReadTransaction["query"];
    type PublicQueryKeysAreDecisionOnly =
      PublicQueryKeys extends "caseLawDecisions" ? true : false;
    type PublicTxCanQueryCaseLawDecisions =
      "caseLawDecisions" extends PublicQueryKeys ? true : false;
    type PublicTxCanQueryMatterLinks =
      "caseLawMatterLinks" extends PublicQueryKeys ? true : false;

    const publicQueryKeysAreDecisionOnly: PublicQueryKeysAreDecisionOnly = true;
    const publicTxCanQueryCaseLawDecisions: PublicTxCanQueryCaseLawDecisions = true;
    const publicTxCanQueryMatterLinks: PublicTxCanQueryMatterLinks = false;

    expect(publicQueryKeysAreDecisionOnly).toBe(true);
    expect(publicTxCanQueryCaseLawDecisions).toBe(true);
    expect(publicTxCanQueryMatterLinks).toBe(false);
  });

  test("public read routes are not protected by auth middleware", async () => {
    const block = publicRouteBlock(await readRoutesSource());

    expect(block).not.toContain("authMacro");
    expect(block).not.toContain("permissionMacro");
    expect(block).not.toContain("workspaceAccessMacro");
    expect(block).not.toContain("validateAuth");
    expect(block).not.toContain("permissions:");
  });

  test("public read handlers use the public-safe handler factory", () => {
    // Was a grep for nine `const x = createSafePublicHandler` lines, which
    // could not see a tenth route or a handler renamed around it. The factory
    // now stamps what it produces, so the census covers every mounted route
    // and cannot be satisfied by naming.
    //
    // Elysia mounts internal entries (HEAD, error pages) whose handler is not
    // one of ours; they carry no stamp and would read as ungoverned. The
    // filter below drops them, and the path census that follows keeps the
    // filter from becoming the escape hatch: dropping everything fails there.
    const declared = publicCaseLawRoute.routes.filter(
      (route) => typeof route.handler === "function",
    );
    const ungoverned = declared
      .filter((route) => !isSafePublicHandler(route.handler))
      .map((route) => `${route.method} ${route.path}`);

    expect(ungoverned).toEqual([]);
    expect(
      declared.map((route) => `${route.method} ${route.path}`).sort(),
    ).toEqual([...PUBLIC_CASE_LAW_ROUTES]);
  });

  test("public decision payload does not expose persisted AI analysis", async () => {
    const source = await readDecisionSource();

    expect(source).not.toContain("analysis: true");
    expect(source).not.toContain("parsePersistedDecisionAnalysis");
  });

  test("public decision payload is an explicit allowlist", async () => {
    const [source, subjectSource] = await Promise.all([
      readDecisionSource(),
      readPublicSubjectSource(),
    ]);

    expect(source).not.toContain("...decision");
    expect(source).toContain("id: decision.id");
    expect(source).toContain("caseNumber: decision.caseNumber");
    expect(source).toContain("slug: decision.slug");
    expect(source).toContain("languageAlternates,");
    expect(source).toContain("language: decision.language");
    expect(source).toContain("fulltext,");
    // Slug lookup and its language matching moved into the gate module, which
    // resolves every subject. Both halves of the normalisation are pinned
    // here; `public-subject.db.test.ts` drives them against Postgres.
    expect(subjectSource).toContain("normalizePublicDecisionLanguage");
    expect(subjectSource).toContain("replace(lower(");
    expect(subjectSource).toContain("'_', '-'");
  });

  test("public facets payload is aggregate public data only", async () => {
    // Facets are provider-dispatched, so the invariant has to hold on the
    // handler and on both implementations behind it.
    const [handlerSource, pgFtsSource, corpusIndexSource] = await Promise.all([
      readFacetsSource(),
      readPgFtsFacetsSource(),
      readCorpusIndexFacetsSource(),
    ]);

    for (const source of [handlerSource, pgFtsSource, corpusIndexSource]) {
      expect(source).not.toContain("analysis");
      expect(source).not.toContain("workspace");
      expect(source).not.toContain("organization");
      expect(source).not.toContain("matter");
    }

    expect(handlerSource).toContain("LIMITS.caseLawFacetLimit");
    expect(pgFtsSource).toContain("caseLawDecisions.country");
    expect(pgFtsSource).toContain("caseLawDecisions.court");
    expect(pgFtsSource).toContain("caseLawDecisions.decisionDate");
    expect(corpusIndexSource).toContain('field: "jurisdiction"');
    expect(corpusIndexSource).toContain('field: "court"');
    expect(corpusIndexSource).toContain(
      "buildAggregations(query.limit, readContract.yearFacetField)",
    );
    expect(
      corpusIndexReadContract("case_law", "case_law_v5").yearFacetField,
    ).toBe("decision_year");
  });

  test("public search payload is aggregate public data only", async () => {
    const source = await readSearchSource();

    expect(source).not.toContain("analysis");
    expect(source).not.toContain("workspace");
    expect(source).not.toContain("organization");
    expect(source).not.toContain("matter");
    expect(source).toContain("d.language_group_key");
    expect(source).toContain("readPublicDecisionLanguageAlternatesByGroup");
    expect(source).toContain("languageAlternates:");
    // The hit contract carries the versions themselves; a count would let a
    // client link a language it cannot resolve.
    expect(source).not.toContain("languageAlternateCount");
  });

  test("public search validates source IDs before SQL filters", async () => {
    const source = await readSearchSchemaSource();

    expect(source).toContain('sourceId: t.Optional(tSafeId("caseLawSource"))');
  });

  test("public cursors validate IDs before SQL filters", async () => {
    const [listSource, searchSource] = await Promise.all([
      readListSource(),
      readSearchSource(),
    ]);

    expect(listSource).toContain("!isUuid(id)");
    expect(searchSource).toContain("!isUuid(parsedCursor.id)");
  });

  test("public language alternates are gated, bounded and route-safe", async () => {
    const [listSource, languageAlternatesSource] = await Promise.all([
      readListSource(),
      readLanguageAlternatesSource(),
    ]);

    expect(listSource).toContain("readPublicDecisionLanguageAlternatesByGroup");
    expect(languageAlternatesSource).toContain("redistributableCaseLawSource,");
    expect(languageAlternatesSource).toContain(
      "LIMITS.caseLawLanguageAlternatesPerGroupMax",
    );
    // One version per route-safe language: the same normalisation the public
    // routes apply, so an alternate the client cannot link is never offered.
    expect(languageAlternatesSource).toContain(
      "normalizePublicDecisionLanguage(alternate.language)",
    );
    expect(languageAlternatesSource).not.toContain("...alternate,");
  });

  test("public sitemap payload is an explicit public allowlist", async () => {
    const source = await readSitemapSource();

    expect(source).not.toContain("...decision");
    expect(source).not.toContain("analysis");
    expect(source).not.toContain("workspace");
    expect(source).not.toContain("organization");
    expect(source).not.toContain("matter");
    expect(source).toContain("id: caseLawDecisions.id");
    expect(source).toContain("caseNumber: caseLawDecisions.caseNumber");
    expect(source).toContain("slug: caseLawDecisions.slug");
    expect(source).toContain("country: caseLawDecisions.country");
    expect(source).toContain("language: caseLawDecisions.language");
    expect(source).toContain("languageAlternates:");
    expect(source).toContain("updatedAt: caseLawDecisions.updatedAt");
    expect(source).toContain("SITEMAP_SHARD_BUCKET_COUNT");
    expect(source).toContain("SITEMAP_LANGUAGE_ALTERNATE_GROUP_BATCH_SIZE");
    expect(source).toContain("normalizeLanguageSegment");
    expect(source).toContain("LIMITS.caseLawSitemapShardUrlLimit");
    expect(source).toContain("bucketRowsByNaturalShard");
    expect(source).toContain("Case-law sitemap bucket exceeds shard capacity");
    expect(source).toContain("LIMITS.caseLawSitemapIndexEntryLimit");
  });

  test("public sitemap shards support EU and three-letter jurisdictions", async () => {
    const source = await readSitemapSource();

    expect(source).toContain('const SITEMAP_COUNTRY_PATTERN = "^[a-z]{2,3}$"');
    expect(source).toContain("country.toUpperCase()");
  });

  test("every public case-law read enforces the shared country boundary", async () => {
    const scopedSources = await Promise.all(
      [
        LIST_DECISIONS_FILE,
        FACETS_DECISIONS_FILE,
        LATEST_DECISIONS_FILE,
        SEARCH_DECISIONS_FILE,
        STATUS_DECISIONS_FILE,
        CITING_DECISIONS_FILE,
      ].map(readSource),
    );
    for (const source of scopedSources) {
      expect(source).toContain("publicCaseLawCountry(");
      // Admission decides whether a country has a corpus; it is handed the
      // canonical alpha-3 the shared reader produced, never the caller's own
      // spelling. A handler that folded the code itself would answer `CZ` and
      // `Česko` with a bare 404 while `read_case_law_decision` reads both.
      expect(source).toContain("readPublicLawCountry(");
    }

    const declaredCountrySources = await Promise.all(
      [
        LIST_DECISIONS_FILE,
        FACETS_DECISIONS_FILE,
        LATEST_DECISIONS_FILE,
        SEARCH_DECISIONS_SCHEMA_FILE,
        STATUS_DECISIONS_FILE,
        CITING_DECISIONS_FILE,
        ROUTES_FILE,
      ].map(readSource),
    );
    for (const source of declaredCountrySources) {
      // One declaration, whose bound is the reader's: a per-endpoint
      // `maxLength: 3` refuses `Czech Republic` with the framework's opaque
      // 422 before a handler can name the notations that are accepted.
      expect(source).toContain("tPublicLawCountry");
    }

    const [subject, sitemap, alternates, citations, readiness] =
      await Promise.all([
        readPublicSubjectSource(),
        readSitemapSource(),
        readLanguageAlternatesSource(),
        readSource(CITATION_GRAPH_FILE),
        readSource(LAUNCH_READINESS_FILE),
      ]);
    expect(subject).toContain("!isPublicCaseLawCountry(row.country)");
    for (const source of [sitemap, alternates, citations]) {
      expect(source).toContain("PUBLIC_CASE_LAW_COUNTRIES");
    }
    expect(readiness).toContain("evalSetExists: v.literal(true)");
    expect(readiness).toContain("lastCensusGreen: v.literal(true)");
  });

  test("every public decision surface enforces the redistribution gate", async () => {
    const listSource = await readListSource();
    const decisionSource = await readDecisionSource();
    const facetsHandlerSource = await readFacetsSource();
    const pgFtsFacetsSource = await readPgFtsFacetsSource();
    const corpusIndexFacetsSource = await readCorpusIndexFacetsSource();
    const corpusIndexProjectionInputSource =
      await readCorpusIndexProjectionInputSource();
    const corpusIndexProjectionDescriptorSource =
      await readCorpusIndexProjectionDescriptorSource();
    const browseFacetsCacheSource = await readBrowseFacetsCacheSource();
    const nonRedistributableSourcesSource =
      await readNonRedistributableSourcesSource();
    const searchSource = await readSearchSource();
    const sitemapSource = await readSitemapSource();
    const languageAlternatesSource = await readLanguageAlternatesSource();

    expect(listSource).toContain("redistributableCaseLawSource");
    // The decision read's only ungated-by-subject query is the alternates
    // list, which lives in the shared module and gates each version there.
    expect(decisionSource).toContain("listPublicDecisionLanguageAlternates(");
    expect(languageAlternatesSource).toContain("redistributableCaseLawSource,");
    // The per-subject gate moved out of the handler and into the factory that
    // mints its subject, so it is enforced for every subject route at once;
    // `public-subject.test.ts` censuses those routes in both directions.
    // The call, not the import: a gate reduced to an unused import still reads
    // as present. `public-subject.db.test.ts` drives a restricted subject to
    // 404 for the behaviour itself.
    expect(await readPublicSubjectSource()).toContain(
      "!isRedistributable(row.descriptor)",
    );
    expect(pgFtsFacetsSource).toContain("redistributableCaseLawSource");
    // The corpus-index facets aggregate the index rather than the table, so
    // the gate is two-sided. Projection reads eligibility off the source
    // descriptor and erases whatever is ineligible; because a revocation only
    // queues that removal, the aggregation additionally excludes whatever is
    // ineligible at query time.
    expect(corpusIndexProjectionInputSource).toContain(
      "redistributionEligible: isRedistributable(sourceDescriptor)",
    );
    expect(corpusIndexProjectionDescriptorSource).toContain(
      "!input.redistributionEligible",
    );
    expect(nonRedistributableSourcesSource).toContain(
      "redistributableCaseLawSource",
    );
    expect(nonRedistributableSourcesSource).toContain(
      "readNonRedistributableCaseLawSourceIds",
    );
    expect(corpusIndexFacetsSource).toContain("query.excludedSourceIds");
    // Resolved ahead of the cache, so a revocation changes the key. Behind it,
    // the revoked source's buckets would stay public for a whole window.
    expect(facetsHandlerSource).toContain(
      "readNonRedistributableCaseLawSourceIds",
    );
    expect(browseFacetsCacheSource).toContain("excludedSourceIds");
    expect(searchSource).toContain("publicCaseLawDecisionJoin");
    expect(
      await readSource("apps/api/src/lib/case-law/search-sql.ts"),
    ).toContain("redistributableCaseLawSource");
    expect(searchSource).toContain("redistributableCaseLawSource");
    expect(sitemapSource).toContain("redistributableCaseLawSource");

    const [decisionProvisionsSource, citingDecisionsSource] = await Promise.all(
      [readSource(DECISION_PROVISIONS_FILE), readSource(CITING_DECISIONS_FILE)],
    );

    // Provisions read one decision's rows, so the gate is the subject they
    // require rather than a join they must remember: the handler cannot be
    // called with a bare id. Citing decisions still span sources and keep
    // their per-row join.
    expect(decisionProvisionsSource).toContain(
      "subject: RedistributableDecisionSubject",
    );
    expect(decisionProvisionsSource).not.toContain("decisionId: SafeId");
    expect(citingDecisionsSource).toContain("redistributableCaseLawSource");
  });

  test("every public case-law read of the decision table excludes listing-only rows", async () => {
    // Derived, not listed: the surface is whatever the route module imports,
    // so a new public read arrives in this census without anyone adding it,
    // and has to be answered for before the suite passes.
    const modules = await collectApiModuleGraph(
      nodePath.resolve(apiSourceRoot, "handlers/case-law/public-routes.ts"),
    );
    const readers = new Map<string, string>();
    await Promise.all(
      [...modules].map(async (modulePath) => {
        const source = await Bun.file(modulePath).text();
        if (DECISION_TABLE_MENTION.test(source)) {
          readers.set(nodePath.relative(repoRoot, modulePath), source);
        }
      }),
    );

    expect([...readers.keys()].toSorted()).toEqual(
      Object.keys(PUBLIC_DECISION_READ_GATES).toSorted(),
    );

    const gates = new Map<string, PublicDecisionReadEntry>(
      Object.entries(PUBLIC_DECISION_READ_GATES),
    );
    const gateOf = (path: string) => gates.get(path)?.gate;
    const carriesPredicate = (source: string) =>
      PUBLIC_DECISION_PREDICATE_TOKENS.some((token) => source.includes(token));

    const ungated = [...readers]
      .filter(
        ([path, source]) =>
          gateOf(path) === PUBLIC_DECISION_READ_GATE.PREDICATE &&
          !carriesPredicate(source),
      )
      .map(([path]) => path);
    expect(ungated).toEqual([]);

    const unbranded = [...readers]
      .filter(
        ([path, source]) =>
          gateOf(path) === PUBLIC_DECISION_READ_GATE.SUBJECT &&
          !source.includes("RedistributableDecisionSubject"),
      )
      .map(([path]) => path);
    expect(unbranded).toEqual([]);

    // An exemption with no reason is the escape hatch this census exists to
    // close, so the reasons are checked rather than trusted. Both exempting
    // gates are covered: a new one added without a reason fails here.
    const unexplained = Object.entries(PUBLIC_DECISION_READ_GATES)
      .filter(
        ([, entry]) =>
          (entry.gate === PUBLIC_DECISION_READ_GATE.NO_ROW_READ ||
            entry.gate === PUBLIC_DECISION_READ_GATE.COUNTS_STORED) &&
          entry.reason.trim().length === 0,
      )
      .map(([path]) => path);
    expect(unexplained).toEqual([]);

    // The count-only gate is the narrowest of the four and must stay that
    // way: a module under it may aggregate, never select a decision's
    // columns. `count(*)` is the whole of what it is allowed to take.
    // The count-only gate stays in the vocabulary for a read that genuinely
    // needs it, and stays narrow: a module under it may aggregate, never
    // select a decision's columns. It has no member today, because the
    // completeness numerator moved to the ingestion connection.
    for (const [path, entry] of Object.entries(PUBLIC_DECISION_READ_GATES)) {
      if (entry.gate !== PUBLIC_DECISION_READ_GATE.COUNTS_STORED) {
        continue;
      }
      const source =
        readers.get(path) ??
        expect.unreachable(`${path} is in the read surface`);
      expect(source).not.toContain("d.fulltext");
      expect(source).not.toContain("d.case_number");
      expect(source).not.toContain("d.metadata");
    }
  });

  test("the coverage request path never counts the corpus", async () => {
    const [coverageSource, arrivalsSource] = await Promise.all([
      readSource(COVERAGE_FILE),
      readSource(COVERAGE_ARRIVALS_FILE),
    ]);

    // How much a source holds is counted on the ingestion connection and read
    // back as an integer. A public request that counted it would walk the
    // source's whole index range on a two-connection pool.
    expect(coverageSource).not.toContain("source-totals");
    expect(coverageSource).toContain("caseLawSources.storedTotal");
    // The one read left against the decision table is a week of one source's
    // arrivals: bounded by the window, and gated like every other public read.
    expect(arrivalsSource).toContain("d.created_at >=");
    expect(arrivalsSource).toContain("publishedCaseLawDecisionSqlFor");
    expect(arrivalsSource).not.toContain("LIMIT");
  });

  test("the coverage route publishes no crawl or lease state", async () => {
    const [coverageSource, arrivalsSource] = await Promise.all([
      readSource(COVERAGE_FILE),
      readSource(COVERAGE_ARRIVALS_FILE),
    ]);

    for (const source of [coverageSource, arrivalsSource]) {
      // The crawl's position, its lease and its failures are how ingestion
      // works, not what the corpus holds. `reported_total_origin` is read,
      // but only through the reporter map: the raw origin never leaves.
      expect(source).not.toContain("syncCursor");
      expect(source).not.toContain("ingestionLease");
      expect(source).not.toContain("observationOrder");
      expect(source).not.toContain("walkError");
      expect(source).not.toContain("errorMessage");
      expect(source).not.toContain("workspace");
      expect(source).not.toContain("organization");
      expect(source).not.toContain("matter");
    }
    // The source row's own id is never part of the payload; the adapter key,
    // which the open-source registry already names, identifies a feed.
    expect(coverageSource).toContain("adapterKey: source.adapterKey");
    expect(coverageSource).not.toContain("id: source.id");
    // A withheld source contributes to nothing, rather than being gated per
    // number further down.
    expect(coverageSource).toContain("redistributableCaseLawSource");
  });

  test("the listing-only predicate has one owner", async () => {
    const [ownerSource, markerSource] = await Promise.all([
      readSource("apps/api/src/lib/case-law/published-decisions.ts"),
      readSource("apps/api/src/lib/legal-search/ingestion-normalization.ts"),
    ]);

    // The owner states the predicate once per spelling, and each spelling is
    // built from the marker module rather than from a literal path of its own.
    expect(ownerSource).toContain(
      "publishedCaseLawDecisionFor = storedObservationHasDetail",
    );
    expect(ownerSource).toContain("storedObservationHasDetailSqlFor(");
    expect(ownerSource).not.toContain("_stellaPartialObservation");
    expect(markerSource).toContain("PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY");
  });

  test("the live citation score and its materialized twin gate the citing side alike", async () => {
    // Two statements over the same citing rows: the lateral that scores a
    // search page now, and the sweep that writes `citation_count` and
    // `citation_authority` for every other public read. A gate on one and not
    // the other is the drift that lets a row the corpus hides still rank the
    // rows it shows.
    const [searchSource, authoritySource] = await Promise.all([
      readSearchSource(),
      readSource(CITATION_AUTHORITY_FILE),
    ]);

    for (const source of [searchSource, authoritySource]) {
      expect(source).toContain(
        'redistributableCaseLawSourceSqlFor("citing_src")',
      );
      expect(source).toContain('publishedCaseLawDecisionSqlFor("citing_d")');
    }
  });

  test("the question suggestion grounds only in what the public gate returns", async () => {
    const suggestSource = await readSource(RESEARCH_SUGGEST_PROMPT_FILE);

    // The grounding is read here, never accepted from the client: the summaries
    // reader is the same redistribution-gated read the answer runner uses, and
    // a decision it withholds simply never reaches the prompt.
    expect(suggestSource).toContain("readPublicDecisionSummaries({");
    expect(suggestSource).toContain("caseLawDb: caseLawPublicReadDb");
    // Only the published headnote, never the decision's own text.
    expect(suggestSource).not.toContain("readDecisionText");
    expect(suggestSource).not.toContain("body.samples");
  });
});
