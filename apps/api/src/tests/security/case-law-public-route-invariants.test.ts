import { afterAll, describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";
import nodePath from "node:path";
import * as v from "valibot";

import {
  PUBLIC_CASE_LAW_COUNTRIES,
  PUBLIC_CASE_LAW_PAGE_COUNTRIES,
} from "@stll/api-contract/case-law-launch-readiness";
import { PUBLIC_COUNTRIES } from "@stll/api-contract/public-country-capability";
import { DECISION_LIST_SORTS } from "@stll/api-contract/search";
import { assertProperty } from "@stll/property-testing";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  decodeCitationCursor,
  encodeCitationCursor,
  encodeCitationPageCursor,
} from "@/api/handlers/case-law/decisions/citation-graph";
import {
  decodeDecisionCitationCursor,
  encodeDecisionCitationCursor,
} from "@/api/handlers/case-law/decisions/get";
import {
  decodeDecisionDateCursor,
  encodeDecisionDateCursor,
} from "@/api/handlers/case-law/decisions/list";
import { searchDecisionsBodySchema } from "@/api/handlers/case-law/decisions/search-schema";
import {
  decodeCitingDecisionsCursor,
  encodeCitingDecisionsCursor,
} from "@/api/handlers/case-law/provisions/citing-decisions";
import {
  decodeProvisionCursor,
  encodeProvisionCursor,
} from "@/api/handlers/case-law/provisions/list-for-decision";
import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";
import {
  decodeListCursor,
  encodeListCursor,
} from "@/api/handlers/legislation/list";
import {
  decodeProvisionHistoryCursor,
  encodeProvisionHistoryCursor,
} from "@/api/handlers/legislation/provision-history";
import { publicLegislationRoute } from "@/api/handlers/legislation/public-routes";
import {
  decodeVersionCursor,
  encodeVersionCursor,
} from "@/api/handlers/legislation/versions";
import { createHttpApp } from "@/api/http/app";
import type { RouteDefinition, RouteEntry } from "@/api/http/route";
import { isPublicReadBudgetHandler } from "@/api/lib/api-handlers";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  decodeDecisionSearchCursor,
  encodeDecisionSearchCursor,
} from "@/api/lib/case-law/decision-search-cursor";
import { CASE_LAW_SURFACE_COUNTRIES } from "@/api/lib/case-law/public-subject";
import {
  publishedCaseLawDecisionFor,
  publishedCaseLawDecisionSqlFor,
} from "@/api/lib/case-law/published-decisions-sql";
import { isValibotSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { corpusIndexReadContract } from "@/api/lib/legal-search/corpus-index-read-contract";
import {
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { NO_EXPANSION_DICTIONARY_IDENTITY } from "@/api/lib/legal-search/morphology/dictionary";
import {
  PARTIAL_OBSERVATION_FIELD,
  PARTIAL_OBSERVATION_KEY,
} from "@/api/lib/legal-search/partial-observation-sql";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { encodePaginationCursor } from "@/api/lib/pagination";
import {
  brandPersistedCaseLawCitationId,
  brandPersistedCaseLawDecisionId,
  brandPersistedLegislationDocumentId,
} from "@/api/lib/safe-id-boundaries";
import { encodeCursor } from "@/api/lib/search/cursor";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { serveForTest } from "@/api/tests/helpers/test-server";

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
const SHARED_POOL_TIMEOUTS_FILE = "apps/api/src/db/shared-pool-timeouts.ts";
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
 * The factory census below asks which mounted handlers carry the stamp.
 * Pinning the mounted set here is what stops the census from passing an
 * empty check: a route that quietly disappeared fails this list instead.
 */
const PUBLIC_CASE_LAW_ROUTES = [
  "GET /case/coverage",
  "GET /case/decisions",
  "GET /case/decisions/:decisionId",
  "GET /case/decisions/:decisionId/citations",
  "GET /case/decisions/:decisionId/citations/leading",
  "GET /case/decisions/:decisionId/citations/summary",
  "GET /case/decisions/:decisionId/provisions",
  "GET /case/decisions/:decisionId/summary",
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
const readLanguageAlternatesSource = async () =>
  await readSource(LANGUAGE_ALTERNATES_FILE);
const readSitemapSource = async () => await readSource(SITEMAP_DECISIONS_FILE);
const readPublicReadDbSource = async () =>
  await readSource(PUBLIC_READ_DB_FILE);

const DECISION_TABLE_MENTION = /caseLawDecisions|case_law_decisions/u;

const TEST_DECISION_ID = brandPersistedCaseLawDecisionId(
  "00000000-0000-4000-8000-000000000001",
);
const TEST_CITATION_ID = brandPersistedCaseLawCitationId(
  "00000000-0000-4000-8000-000000000002",
);
const TEST_DOCUMENT_ID = brandPersistedLegislationDocumentId(
  "00000000-0000-4000-8000-000000000003",
);
const TEST_CONTEXT = "a".repeat(64);
const CITATION_QUERY = { direction: "outgoing" } as const;

const publicCursorRouteKey = (method: string, path: string, field: string) =>
  `${method} ${path}#${field}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The field names a valibot object schema (or each option of a union) reads. */
const schemaFields = (schema: unknown): string[] => {
  if (!isRecord(schema)) {
    return [];
  }
  const entries = schema["entries"];
  if (isRecord(entries)) {
    return Object.keys(entries);
  }
  const options = schema["options"];
  return Array.isArray(options) ? options.flatMap(schemaFields) : [];
};

const cursorFields = (schema: unknown) => [
  ...new Set(
    schemaFields(schema).filter((field) =>
      field.toLowerCase().endsWith("cursor"),
    ),
  ),
];

const PUBLIC_LAW_ROUTES: readonly RouteEntry[] = [
  ...publicCaseLawRoute,
  ...publicLegislationRoute,
];

const publicCursorRoutes = PUBLIC_LAW_ROUTES.flatMap((route) =>
  (["query", "body"] as const).flatMap((location) => {
    const schema = route.definition.config[location];
    return cursorFields(schema).map((field) => ({
      field,
      key: publicCursorRouteKey(route.method, route.path, field),
      location,
      schema: isValibotSchema(schema) ? schema : undefined,
    }));
  }),
);

/**
 * Whether the route's own schema refuses the request's cursor, read the way
 * the core reads that slot. A route whose schema decodes the cursor (on the
 * field, or across fields as a citation cursor bound to its direction does)
 * refuses it as an invalid request; one that decodes it in the handler
 * answers it there.
 */
const schemaRefusesCursor = async (
  schema: v.GenericSchema | undefined,
  location: "query" | "body",
  field: string,
  request: Request,
): Promise<boolean> => {
  if (schema === undefined) {
    return false;
  }
  const input: unknown =
    location === "query"
      ? Object.fromEntries(new URL(request.url).searchParams)
      : await request.json();
  const { issues } = await v.safeParseAsync(schema, input);
  return (issues ?? []).some((issue) =>
    (issue.path ?? []).some((item) => item.key === field),
  );
};

/** The public law routes alone, behind the boundary that answers failures. */
const publicLawServer = serveForTest(
  createHttpApp({ routes: PUBLIC_LAW_ROUTES, middleware: [errorBoundary] }),
);
afterAll(async () => {
  await publicLawServer.stop();
});

/** The safe factory's handler a definition carries, when a factory built it. */
const handlerOf = (definition: RouteDefinition): unknown =>
  "handler" in definition ? definition.handler : undefined;

const publicCursorRouteRequests: Record<string, () => Request> = {
  "GET /case/decisions#cursor": () =>
    new Request(
      "http://localhost/case/decisions?country=CZE&cursor=not-a-cursor",
    ),
  "GET /case/decisions/by-slug/:slug#citationsCursor": () =>
    new Request(
      "http://localhost/case/decisions/by-slug/test?country=CZE&citationsCursor=not-a-cursor",
    ),
  "GET /case/decisions/:decisionId#citationsCursor": () =>
    new Request(
      `http://localhost/case/decisions/${TEST_DECISION_ID}?citationsCursor=not-a-cursor`,
    ),
  "GET /case/decisions/:decisionId/citations#cursor": () =>
    new Request(
      `http://localhost/case/decisions/${TEST_DECISION_ID}/citations?direction=incoming&cursor=not-a-cursor`,
    ),
  "GET /case/decisions/:decisionId/provisions#cursor": () =>
    new Request(
      `http://localhost/case/decisions/${TEST_DECISION_ID}/provisions?cursor=not-a-cursor`,
    ),
  "GET /case/provisions/citing-decisions#cursor": () =>
    new Request(
      "http://localhost/case/provisions/citing-decisions?jurisdiction=CZE&work=test&cursor=not-a-cursor",
    ),
  "POST /case/decisions/search#cursor": () =>
    new Request("http://localhost/case/decisions/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        country: "CZE",
        query: "test",
        cursor: "not-a-cursor",
      }),
    }),
  "GET /law/statutes#cursor": () =>
    new Request(
      "http://localhost/law/statutes?country=CZE&cursor=not-a-cursor",
    ),
  "GET /law/statutes/search#cursor": () =>
    new Request(
      "http://localhost/law/statutes/search?country=CZE&query=test&cursor=not-a-cursor",
    ),
  "GET /law/statutes/:documentId/versions#cursor": () =>
    new Request(
      `http://localhost/law/statutes/${TEST_DOCUMENT_ID}/versions?cursor=not-a-cursor`,
    ),
  "GET /law/statutes/:documentId/provisions/:anchor/history#cursor": () =>
    new Request(
      `http://localhost/law/statutes/${TEST_DOCUMENT_ID}/provisions/p-1/history?cursor=not-a-cursor`,
    ),
};

const publicRouteBlock = (source: string): string => {
  const start = source.indexOf("export const publicCaseLawRoute");

  expect(start).toBeGreaterThanOrEqual(0);

  return source.slice(start);
};

describe("public case-law route boundary", () => {
  test("public law APIs are dark-launched outside local development", async () => {
    const previousFeature = env.FEATURE_PUBLIC_LAW;
    env.FEATURE_PUBLIC_LAW = false;
    const restoreRuntimeMode = setRuntimeModeForTesting({
      mode: RUNTIME_MODE.strict,
    });
    try {
      // Each route mounts its own response schema; the gate's 404 must be
      // served for all of them, not rejected by response validation.
      for (const path of [
        "/case/coverage",
        "/case/decisions",
        "/case/decisions/status",
        "/law/statutes",
        "/law/statutes/search?q=zakon",
      ]) {
        const response = await publicLawServer.fetch(`http://localhost${path}`);

        expect({ path, status: response.status }).toEqual({
          path,
          status: 404,
        });
      }
    } finally {
      restoreRuntimeMode();
      env.FEATURE_PUBLIC_LAW = previousFeature;
    }
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
    const timeoutSource = await readSource(SHARED_POOL_TIMEOUTS_FILE);
    const guards = source.slice(
      source.indexOf("const PUBLIC_LAW_READ_GUARDS"),
      source.indexOf("export const configureReadTransaction"),
    );
    const readConfiguration = source.slice(
      source.indexOf("const configureReadTransaction"),
      source.indexOf("const publicLawReadGuards"),
    );
    const validation = source.slice(
      source.indexOf("const startRoleValidation"),
      source.indexOf("const ensureRoleValidated"),
    );
    const publicRead = source.slice(
      source.indexOf("export const publicLawReadDb"),
    );
    const sharedReadGuards = timeoutSource.slice(
      timeoutSource.indexOf("export const setSharedReadTransactionGuards"),
      timeoutSource.indexOf("const readCurrentStatementTimeoutMs"),
    );

    expect(source).toContain(
      "connectionTimeout: EXTERNAL_PUBLIC_LAW_CONNECTION_TIMEOUT_SECONDS",
    );
    expect(validation).toContain(".transaction(async (tx) =>");
    expect(guards).toContain('["statement_timeout", "30s"]');
    expect(guards).toContain('["lock_timeout", "1s"]');
    expect(guards).toContain('["idle_in_transaction_session_timeout", "30s"]');
    expect(readConfiguration).toContain(
      "await setSharedReadTransactionGuards(tx, {",
    );
    expect(readConfiguration).toContain(
      "if (!readOnly || statementTimeoutMs === undefined)",
    );
    expect(sharedReadGuards).toContain("await tx.execute(sql`");
    expect(sharedReadGuards).toContain(
      "set_config('transaction_read_only', 'on', true)",
    );
    expect(sharedReadGuards).toContain("set_config('statement_timeout',");
    expect(sharedReadGuards).toContain("set_config('lock_timeout',");
    expect(sharedReadGuards).toContain(
      "set_config('idle_in_transaction_session_timeout',",
    );
    expect(validation).toContain("configureReadTransaction(");
    expect(validation).toContain("validateExternalPublicLawDatabase(tx)");
    expect(validation.indexOf("configureReadTransaction(")).toBeLessThan(
      validation.indexOf("validateExternalPublicLawDatabase(tx)"),
    );
    expect(publicRead).toContain("configureReadTransaction(");
    expect(publicRead).toContain("return await fn(tx)");
    expect(publicRead.indexOf("configureReadTransaction(")).toBeLessThan(
      publicRead.indexOf("return await fn(tx)"),
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

  test("public read transactions have no base-table relational query surface", () => {
    type PublicReadCanQuery = "query" extends keyof CaseLawPublicReadTransaction
      ? true
      : false;
    const publicReadCanQuery: PublicReadCanQuery = false;
    expect(publicReadCanQuery).toBe(false);
  });

  test("public read routes are not protected by auth middleware", async () => {
    // Who may call a route is its definition's own decision: every public
    // read is answered without resolving a caller.
    expect(
      publicCaseLawRoute
        .filter((route) => route.definition.access !== "public")
        .map((route) => `${route.method} ${route.path}`),
    ).toEqual([]);

    const block = publicRouteBlock(await readRoutesSource());

    expect(block).not.toContain("authenticateMember");
    expect(block).not.toContain("authenticateSession");
    expect(block).not.toContain("authorizeWorkspace");
    expect(block).not.toContain("validateAuth");
    expect(block).not.toContain("permissions:");
  });

  test("public read handlers use the budgeted public-safe handler factory", () => {
    // Was a grep for nine `const x = createSafePublicHandler` lines, which
    // could not see a tenth route or a handler renamed around it. The factory
    // now stamps what it produces, so the census covers every mounted route
    // and cannot be satisfied by naming. The path census that follows pins
    // the routes the stamp check saw, so a route that quietly disappeared
    // fails here rather than passing an empty check.
    const ungoverned = publicCaseLawRoute
      .filter(
        (route) => !isPublicReadBudgetHandler(handlerOf(route.definition)),
      )
      .map((route) => `${route.method} ${route.path}`);

    expect(ungoverned).toEqual([]);
    expect(
      publicCaseLawRoute
        .map((route) => `${route.method} ${route.path}`)
        .toSorted(),
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
    expect(pgFtsSource).toContain("caseLawBrowseFacetCounts.country");
    expect(pgFtsSource).toContain('eq(caseLawBrowseFacetCounts.kind, "court")');
    expect(pgFtsSource).toContain('eq(caseLawBrowseFacetCounts.kind, "year")');
    expect(pgFtsSource).toContain("redistributableCaseLawSource");
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

  test("public search validates source IDs before SQL filters", () => {
    const sourceIdIssues = (sourceId: string) =>
      (
        v.safeParse(searchDecisionsBodySchema, {
          country: "CZE",
          query: "test",
          sourceId,
        }).issues ?? []
      ).filter((issue) =>
        (issue.path ?? []).some((item) => item.key === "sourceId"),
      );

    expect(sourceIdIssues("' OR 1=1 --").length).toBeGreaterThan(0);
    expect(sourceIdIssues("not-a-uuid").length).toBeGreaterThan(0);
    expect(sourceIdIssues("00000000-0000-4000-8000-000000000004")).toEqual([]);
  });

  test("every public pagination cursor route has a behavioural guard", async () => {
    const enumerated = publicCursorRoutes.map(({ key }) => key).toSorted();
    const covered = Object.keys(publicCursorRouteRequests).toSorted();

    expect(covered).toEqual(enumerated);

    for (const { key, field, location, schema } of publicCursorRoutes) {
      const requestForRoute = publicCursorRouteRequests[key];
      if (requestForRoute === undefined) {
        throw new Error(`Missing public cursor route guard for ${key}`);
      }
      const schemaRefuses = await schemaRefusesCursor(
        schema,
        location,
        field,
        requestForRoute(),
      );
      const response = await publicLawServer.fetch(requestForRoute());
      const body: unknown = await response.json();

      // Either way the cursor alone is refused, before any read: the core
      // names it as the one invalid field (422), or the handler's decoder
      // answers it (400).
      expect({ key, status: response.status, body }).toEqual(
        schemaRefuses
          ? {
              key,
              status: 422,
              body: {
                code: "validation",
                message: "Invalid request",
                issues: [{ field, constraint: "invalid" }],
              },
            }
          : { key, status: 400, body: { message: "Invalid cursor" } },
      );
    }
  });

  test("public cursor decoders reject invalid IDs and round-trip issued cursors", () => {
    const invalidId = fc.constantFrom(
      "",
      "' OR 1=1 --",
      "x".repeat(513),
      "v2:00000000-0000-4000-8000-000000000001",
    );

    assertProperty(
      "public cursor decoders reject invalid IDs and round-trip issued cursors",
      fc.property(invalidId, (id) => {
        const invalidCursors = [
          ...DECISION_LIST_SORTS.map(
            (sort) =>
              [
                (cursor: string) => decodeDecisionDateCursor(cursor, sort),
                encodePaginationCursor([sort, "2026-01-01", id]),
              ] as const,
          ),
          [
            (cursor: string) => decodeCitationCursor(cursor, CITATION_QUERY),
            encodePaginationCursor([id, CITATION_QUERY.direction, null, null]),
          ],
          [
            decodeCitingDecisionsCursor,
            encodePaginationCursor([TEST_CONTEXT, "2026-01-01", id]),
          ],
          [
            decodeListCursor,
            encodePaginationCursor(["recent-v1", "2026-01-01", id]),
          ],
          [decodeVersionCursor, encodePaginationCursor(["2026-01-01", id])],
          [
            decodeProvisionHistoryCursor,
            encodePaginationCursor(["2026-01-01", id]),
          ],
          [decodeDecisionSearchCursor, encodeCursor(1, `relevance:${id}`)],
          [decodeCorpusSearchCursor, encodeCursor(1, `0:none:relevance:${id}`)],
        ] as const;

        for (const [index, [decode, cursor]] of invalidCursors.entries()) {
          const value = decode(cursor);
          if (value !== null) {
            throw new Error(`decoder ${index} accepted ${JSON.stringify(id)}`);
          }
        }

        // A citation page cursor decodes to the citation id alone.
        expect(
          decodeCitationCursor(
            encodeCitationPageCursor({
              id: TEST_CITATION_ID,
              query: CITATION_QUERY,
            }),
            CITATION_QUERY,
          ),
        ).toBe(TEST_CITATION_ID);

        const roundTrips = [
          ...DECISION_LIST_SORTS.map((sort) => ({
            decoded: decodeDecisionDateCursor(
              encodeDecisionDateCursor({
                sort,
                decisionDate: "2026-01-01",
                id: TEST_DECISION_ID,
              }),
              sort,
            ),
            expected: {
              sort,
              decisionDate: "2026-01-01",
              id: TEST_DECISION_ID,
            },
          })),
          {
            decoded: decodeDecisionCitationCursor(
              encodeDecisionCitationCursor({
                from: {
                  after: encodeCitationCursor(TEST_CITATION_ID),
                  status: "continue",
                },
                to: {
                  after: encodeCitationCursor(TEST_CITATION_ID),
                  status: "continue",
                },
              }),
            ),
            expected: {
              from: {
                after: encodeCitationCursor(TEST_CITATION_ID),
                status: "continue",
              },
              to: {
                after: encodeCitationCursor(TEST_CITATION_ID),
                status: "continue",
              },
            },
          },
          {
            decoded: decodeProvisionCursor(
              encodeProvisionCursor({
                generation: "1",
                spanStart: 0,
                anchor: "p-1",
              }),
            ),
            expected: {
              generation: "1",
              spanStart: 0,
              anchor: "p-1",
            },
          },
          {
            decoded: decodeCitingDecisionsCursor(
              encodeCitingDecisionsCursor({
                context: TEST_CONTEXT,
                decisionDate: "2026-01-01",
                decisionId: TEST_DECISION_ID,
              }),
            ),
            expected: {
              context: TEST_CONTEXT,
              decisionDate: "2026-01-01",
              decisionId: TEST_DECISION_ID,
            },
          },
          {
            decoded: decodeListCursor(
              encodeListCursor({
                type: "recent-v1",
                validFrom: "2026-01-01",
                id: TEST_DOCUMENT_ID,
              }),
            ),
            expected: {
              type: "recent-v1",
              validFrom: "2026-01-01",
              id: TEST_DOCUMENT_ID,
            },
          },
          {
            decoded: decodeVersionCursor(
              encodeVersionCursor({
                validFrom: "2026-01-01",
                id: TEST_DOCUMENT_ID,
              }),
            ),
            expected: {
              validFrom: "2026-01-01",
              id: TEST_DOCUMENT_ID,
            },
          },
          {
            decoded: decodeProvisionHistoryCursor(
              encodeProvisionHistoryCursor({
                validFrom: "2026-01-01",
                id: TEST_DOCUMENT_ID,
              }),
            ),
            expected: {
              validFrom: "2026-01-01",
              id: TEST_DOCUMENT_ID,
            },
          },
          {
            decoded: decodeDecisionSearchCursor(
              encodeDecisionSearchCursor({
                id: TEST_DECISION_ID,
                sort: "relevance",
                sortKey: 1,
              }),
            ),
            expected: {
              id: TEST_DECISION_ID,
              sort: "relevance",
              sortKey: 1,
            },
          },
          {
            decoded: decodeCorpusSearchCursor(
              encodeCorpusSearchCursor({
                dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
                id: TEST_DECISION_ID,
                score: 1,
                sort: "relevance",
                target: null,
                windowStart: 0,
              }),
            ),
            expected: {
              dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
              id: TEST_DECISION_ID,
              score: 1,
              sort: "relevance",
              target: null,
              windowStart: 0,
            },
          },
        ];
        for (const { decoded, expected } of roundTrips) {
          expect(decoded).toMatchObject(expected);
        }
      }),
      { numRuns: 40 },
    );
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
    expect(source).toContain("id: publishedCaseLawDecisions.id");
    expect(source).toContain(
      "caseNumber: publishedCaseLawDecisions.caseNumber",
    );
    expect(source).toContain("slug: publishedCaseLawDecisions.slug");
    expect(source).toContain("country: publishedCaseLawDecisions.country");
    expect(source).toContain("language: publishedCaseLawDecisions.language");
    expect(source).toContain("languageAlternates:");
    expect(source).toContain("updatedAt: publishedCaseLawDecisions.updatedAt");
    expect(source).toContain("decisionBucketSql");
    expect(source).toContain("SITEMAP_LANGUAGE_ALTERNATE_GROUP_BATCH_SIZE");
    expect(source).toContain("normalizeLanguageSegment");
    expect(source).toContain("LIMITS.caseLawSitemapShardUrlLimit");
    // The index lists the refreshed snapshot's own columns, never a count.
    expect(source).toContain(".from(caseLawSitemapShards)");
    expect(source).toContain(
      "lastModifiedAt: caseLawSitemapShards.lastModifiedAt",
    );
    expect(source).toContain(
      "Case-law sitemap shard count exceeds sitemap index capacity",
    );
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
    // The subject gate resolves the surface it was asked for to one country
    // list, from one table that names both, and checks the row against it.
    // The subject carries that list, and the citation graph filters the
    // subject's far ends against it, so a far end answers to the same surface.
    expect(subject).toContain("!isListed(countries, row.country)");
    expect(subject).toContain("CASE_LAW_SURFACE_COUNTRIES[surface]");
    for (const entry of [
      "pages: PUBLIC_CASE_LAW_PAGE_COUNTRIES,",
      "search: PUBLIC_CASE_LAW_COUNTRIES,",
    ]) {
      expect(subject).toContain(entry);
    }
    expect(citations).toContain("[...countries]");
    for (const source of [sitemap, alternates]) {
      expect(source).toContain("PUBLIC_CASE_LAW_PAGE_COUNTRIES");
    }
    // Behaviour, not spelling: the default table is the contract's two lists,
    // pages a superset of search. A pages-public decision's own behaviour on
    // both surfaces is proven in citation-graph-surface.db.test.ts.
    expect(CASE_LAW_SURFACE_COUNTRIES.pages).toEqual(
      PUBLIC_CASE_LAW_PAGE_COUNTRIES,
    );
    expect(CASE_LAW_SURFACE_COUNTRIES.search).toEqual(
      PUBLIC_CASE_LAW_COUNTRIES,
    );
    for (const country of PUBLIC_COUNTRIES) {
      if (CASE_LAW_SURFACE_COUNTRIES.search.includes(country)) {
        expect(CASE_LAW_SURFACE_COUNTRIES.pages).toContain(country);
      }
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
    // The week's arrivals are counted by the scheduler and read back as one
    // stored integer per source: the request path reads no decision row.
    expect(arrivalsSource).not.toMatch(DECISION_TABLE_MENTION);
    expect(arrivalsSource).toContain(".from(caseLawSourceArrivals)");
    expect(arrivalsSource).not.toContain('source-arrivals-refresh"');
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

  test("the publication predicate has one owner", () => {
    const rendered = [
      new PgDialect().sqlToQuery(publishedCaseLawDecisionFor(caseLawDecisions))
        .sql,
      publishedCaseLawDecisionSqlFor("decision"),
    ];

    for (const predicate of rendered) {
      expect(predicate).toContain("IS NULL AND");
      expect(predicate).toContain("jsonb_extract_path_text");
      expect(predicate).toContain(PARTIAL_OBSERVATION_KEY);
      expect(predicate).toContain(PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY);
      expect(predicate).toContain("is distinct from 'true'");
    }
  });

  test("every related-decision read in the citation graph goes through its one gate", async () => {
    const source = await readSource(CITATION_GRAPH_FILE);
    const count = (token: string) => source.split(token).length - 1;

    // Source and country admission remain shared by the visibility gate;
    // decision membership is supplied by the published view.
    for (const component of [
      "redistributableCaseLawSourceFor(",
      "[...countries]",
    ]) {
      expect({ component, count: count(component) }).toEqual({
        component,
        count: 1,
      });
    }
    // Every read that joins the far end's source applies the gate to it.
    const joins = count("Join(relatedSource,");
    expect(joins).toBeGreaterThan(0);
    expect(count("visibleFor({")).toBe(joins);
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
      expect(source).toContain("case_law_published_decisions citing_d");
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
