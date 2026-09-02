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

type ScopedDbIsPublicReadDb = ScopedDb extends CaseLawPublicReadDb
  ? true
  : false;

// @ts-expect-error ScopedDb must not satisfy the branded public-read boundary.
const scopedDbIsPublicReadDb: ScopedDbIsPublicReadDb = true;
void scopedDbIsPublicReadDb;

const ROUTES_FILE = "apps/api/src/handlers/case-law/public-routes.ts";
const LIST_DECISIONS_FILE = "apps/api/src/handlers/case-law/decisions/list.ts";
const READ_DECISION_FILE = "apps/api/src/handlers/case-law/decisions/get.ts";
const PUBLIC_SUBJECT_FILE =
  "apps/api/src/handlers/case-law/decisions/public-subject.ts";
const DEFERRED_DOCUMENT_FILE =
  "apps/api/src/handlers/case-law/decisions/get-deferred-document.ts";
const FACETS_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/decisions/facets.ts";
const PG_FTS_FACETS_FILE =
  "apps/api/src/lib/legal-search/pg-fts-browse-facets.ts";
const CORPUS_INDEX_FACETS_FILE =
  "apps/api/src/lib/legal-search/corpus-index-facets.ts";
const CORPUS_INDEX_PROJECTION_FILE =
  "apps/api/src/handlers/case-law/corpus-index.ts";
const BROWSE_FACETS_CACHE_FILE =
  "apps/api/src/lib/legal-search/browse-facets-cache.ts";
const NON_REDISTRIBUTABLE_SOURCES_FILE =
  "apps/api/src/lib/case-law/non-redistributable-sources.ts";
const SEARCH_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/decisions/search.ts";
const SEARCH_DECISIONS_SCHEMA_FILE =
  "apps/api/src/handlers/case-law/decisions/search-schema.ts";
const LANGUAGE_ALTERNATES_FILE =
  "apps/api/src/lib/case-law/language-alternates.ts";
const SITEMAP_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/decisions/sitemap.ts";
const PUBLIC_READ_DB_FILE = "apps/api/src/lib/public-law-read-db.ts";
const DECISION_PROVISIONS_FILE =
  "apps/api/src/handlers/case-law/provisions/list-for-decision.ts";
const CITING_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/provisions/citing-decisions.ts";

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
const readCorpusIndexProjectionSource = async () =>
  await readSource(CORPUS_INDEX_PROJECTION_FILE);
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

    expect(source).toContain("SET TRANSACTION READ ONLY");
  });

  test("external role validation is bounded and retries after failure", async () => {
    const source = await readPublicReadDbSource();
    const readConfiguration = source.slice(
      source.indexOf("const configureReadTransaction"),
      source.indexOf("const configureExternalReadTransaction"),
    );
    const externalConfiguration = source.slice(
      source.indexOf("const configureExternalReadTransaction"),
      source.indexOf("const startRoleValidation"),
    );
    const validation = source.slice(
      source.indexOf("const startRoleValidation"),
      source.indexOf("const ensureRoleValidated"),
    );

    expect(source).toContain(
      "connectionTimeout: EXTERNAL_PUBLIC_LAW_CONNECTION_TIMEOUT_SECONDS",
    );
    expect(validation).toContain(".transaction(async (tx) =>");
    expect(readConfiguration).toContain(
      "await tx.execute(sql`SET LOCAL statement_timeout = '30s'`)",
    );
    expect(externalConfiguration).toContain(
      "await configureReadTransaction(tx, isolation)",
    );
    expect(externalConfiguration).toContain(
      "await tx.execute(sql`SET LOCAL lock_timeout = '1s'`)",
    );
    expect(externalConfiguration).toContain(
      "await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '30s'`)",
    );
    expect(
      validation.indexOf("configureExternalReadTransaction(tx)"),
    ).toBeLessThan(validation.indexOf("validateExternalPublicLawDatabase(tx)"));
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
      corpusIndexReadContract("case_law", "case_law_v4").yearFacetField,
    ).toBe("year");
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

  test("every public decision surface enforces the redistribution gate", async () => {
    const listSource = await readListSource();
    const decisionSource = await readDecisionSource();
    const facetsHandlerSource = await readFacetsSource();
    const pgFtsFacetsSource = await readPgFtsFacetsSource();
    const corpusIndexFacetsSource = await readCorpusIndexFacetsSource();
    const corpusIndexProjectionSource = await readCorpusIndexProjectionSource();
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
    // the gate is two-sided. Projection keeps ineligible sources out of the
    // index; because a revocation only queues their removal, the aggregation
    // additionally excludes whatever is ineligible at query time.
    expect(corpusIndexProjectionSource).toContain(
      "redistributableCaseLawSource",
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
    expect(searchSource).toContain("redistributableSourceJoin");
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
});
