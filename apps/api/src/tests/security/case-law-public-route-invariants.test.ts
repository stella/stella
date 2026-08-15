import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import type { ScopedDb } from "@/api/db/safe-db";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";

type ScopedDbIsPublicReadDb = ScopedDb extends CaseLawPublicReadDb
  ? true
  : false;

// @ts-expect-error ScopedDb must not satisfy the branded public-read boundary.
const scopedDbIsPublicReadDb: ScopedDbIsPublicReadDb = true;
void scopedDbIsPublicReadDb;

const ROUTES_FILE = "apps/api/src/handlers/case-law/public-routes.ts";
const LIST_DECISIONS_FILE = "apps/api/src/handlers/case-law/decisions/list.ts";
const READ_DECISION_FILE = "apps/api/src/handlers/case-law/decisions/get.ts";
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
const SEARCH_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/decisions/search.ts";
const SEARCH_DECISIONS_SCHEMA_FILE =
  "apps/api/src/handlers/case-law/decisions/search-schema.ts";
const LANGUAGE_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/decisions/language.ts";
const SITEMAP_DECISIONS_FILE =
  "apps/api/src/handlers/case-law/decisions/sitemap.ts";
const PUBLIC_READ_DB_FILE = "apps/api/src/lib/case-law-public-read-db.ts";

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
const readSource = async (path: string) =>
  await Bun.file(nodePath.resolve(repoRoot, path)).text();

const readRoutesSource = async () => await readSource(ROUTES_FILE);
const readListSource = async () => await readSource(LIST_DECISIONS_FILE);
const readDecisionSource = async () => await readSource(READ_DECISION_FILE);
const readDeferredDocumentSource = async () =>
  await readSource(DEFERRED_DOCUMENT_FILE);
const readFacetsSource = async () => await readSource(FACETS_DECISIONS_FILE);
const readPgFtsFacetsSource = async () => await readSource(PG_FTS_FACETS_FILE);
const readCorpusIndexFacetsSource = async () =>
  await readSource(CORPUS_INDEX_FACETS_FILE);
const readCorpusIndexProjectionSource = async () =>
  await readSource(CORPUS_INDEX_PROJECTION_FILE);
const readSearchSource = async () => await readSource(SEARCH_DECISIONS_FILE);
const readSearchSchemaSource = async () =>
  await readSource(SEARCH_DECISIONS_SCHEMA_FILE);
const readLanguageSource = async () =>
  await readSource(LANGUAGE_DECISIONS_FILE);
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
    const validation = source.slice(
      source.indexOf("const startRoleValidation"),
      source.indexOf("const ensureRoleValidated"),
    );

    expect(source).toContain(
      "connectionTimeout: EXTERNAL_CASE_LAW_CONNECTION_TIMEOUT_SECONDS",
    );
    expect(validation).toContain(".transaction(async (tx) =>");
    expect(
      validation.indexOf("configureExternalReadTransaction(tx)"),
    ).toBeLessThan(validation.indexOf("validateExternalCaseLawDatabase(tx)"));
    expect(validation).toContain(
      'external.roleValidation = { status: "idle" }',
    );
  });

  test("shared-corpus reads cannot start document ingestion", async () => {
    const source = await readDeferredDocumentSource();
    const guard = source.indexOf("envBase.CASE_LAW_DATABASE_URL !== undefined");
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

  test("public read handlers use the public-safe handler factory", async () => {
    const source = await readRoutesSource();

    expect(source).toContain("const listDecisions = createSafePublicHandler");
    expect(source).toContain(
      "const listDecisionFacets = createSafePublicHandler",
    );
    expect(source).toContain("const readDecision = createSafePublicHandler");
    expect(source).toContain(
      "const readDecisionBySlug = createSafePublicHandler",
    );
    expect(source).toContain("const searchDecisions = createSafePublicHandler");
    expect(source).toContain(
      "const listSitemapShardDecisions = createSafePublicHandler",
    );
    expect(source).toContain(
      "const listSitemapShards = createSafePublicHandler",
    );
  });

  test("public decision payload does not expose persisted AI analysis", async () => {
    const source = await readDecisionSource();

    expect(source).not.toContain("analysis: true");
    expect(source).not.toContain("parsePersistedDecisionAnalysis");
  });

  test("public decision payload is an explicit allowlist", async () => {
    const source = await readDecisionSource();

    expect(source).not.toContain("...decision");
    expect(source).toContain("id: decision.id");
    expect(source).toContain("caseNumber: decision.caseNumber");
    expect(source).toContain("slug: decision.slug");
    expect(source).toContain("languageAlternates,");
    expect(source).toContain("normalizePublicDecisionLanguage");
    expect(source).toContain("replace(lower(");
    expect(source).toContain("caseLawDecisions.language");
    expect(source).toContain("fulltext,");
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
    expect(corpusIndexSource).toContain('field: "year"');
  });

  test("public search payload is aggregate public data only", async () => {
    const source = await readSearchSource();

    expect(source).not.toContain("analysis");
    expect(source).not.toContain("workspace");
    expect(source).not.toContain("organization");
    expect(source).not.toContain("matter");
    expect(source).toContain("d.language_group_key");
    expect(source).toContain("validCaseLawLanguageAlternateCountSql");
    expect(source).toContain("languageAlternateCount:");
    expect(source).toContain("languageGroupKey,");
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

  test("public language alternate counts only include route-safe languages", async () => {
    const [listSource, searchSource, languageSource] = await Promise.all([
      readListSource(),
      readSearchSource(),
      readLanguageSource(),
    ]);

    expect(listSource).toContain("validCaseLawLanguageAlternateCountSql");
    expect(searchSource).toContain("validCaseLawLanguageAlternateCountSql");
    expect(languageSource).toContain("count(distinct");
    expect(languageSource).toContain("replace(lower(");
    expect(languageSource).toContain("filter (where");
    expect(languageSource).toMatch(
      /~ \$\{CASE_LAW_LANGUAGE_SEGMENT_PATTERN\}/u,
    );
    expect(languageSource).toContain("^[a-z]{2,3}(-[a-z0-9]{2,8})*$");
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
    const pgFtsFacetsSource = await readPgFtsFacetsSource();
    const corpusIndexProjectionSource = await readCorpusIndexProjectionSource();
    const searchSource = await readSearchSource();
    const sitemapSource = await readSitemapSource();

    expect(listSource).toContain("redistributableCaseLawSource");
    expect(decisionSource).toContain("redistributableCaseLawSource");
    expect(decisionSource).toContain("isRedistributable");
    expect(pgFtsFacetsSource).toContain("redistributableCaseLawSource");
    // The corpus-index facets aggregate the index rather than the table, so
    // their gate is the projection's: only redistributable decisions are ever
    // indexed, which is what makes counting the index safe to serve publicly.
    expect(corpusIndexProjectionSource).toContain(
      "redistributableCaseLawSource",
    );
    expect(searchSource).toContain("redistributableSourceJoin");
    expect(searchSource).toContain("redistributableCaseLawSource");
    expect(sitemapSource).toContain("redistributableCaseLawSource");
  });
});
