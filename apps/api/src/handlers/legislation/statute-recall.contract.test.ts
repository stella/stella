import type { PGlite } from "@electric-sql/pglite";
import { Value } from "@sinclair/typebox/value";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import Elysia from "elysia";
import * as v from "valibot";

import { normalizeEli } from "@stll/agent-input";
import { readStatuteQueryReferences } from "@stll/api-contract/statute-query-intent";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { createPublicStatuteSearch } from "@/api/handlers/legislation/public-search";
import { searchLegislationHandler } from "@/api/handlers/legislation/search";
import { searchLegislationSuccessResponseSchema } from "@/api/handlers/legislation/search-schema";
import { toSafeId } from "@/api/lib/branded-types";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { buildLegislationV2ProjectionDocuments } from "@/api/lib/legal-search/corpus-index-projection-builder";
import type { LegislationV2ProjectionInput } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { corpusFreeTextClause } from "@/api/lib/legal-search/corpus-query";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

import fixtureBaseline from "./fixtures/statute-recall/baseline.json";
import fixtureDocuments from "./fixtures/statute-recall/documents.json";
import fixtureQueries from "./fixtures/statute-recall/queries.json";

const runEngineTests = process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] === "true";
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
const INDEX_ID = `legislation_v2_recall_${Date.now().toString(36)}`;
const SERVING_INDEX_ID = corpusIndexId(MANIFEST.generation, "CZE");
const ENGINE_TIMEOUT_MS = 120_000;
const FINGERPRINT = "a".repeat(64);
const sourceId = toSafeId<"legislationSource">(
  "00000000-0000-7000-8000-000000000001",
);
const corpusClient = getCorpusIndexClient("q09");
const BASELINE_PATH =
  "apps/api/src/handlers/legislation/fixtures/statute-recall/baseline.json";
const baselineSchema = v.strictObject({
  top5Floor: v.nullable(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16)),
  ),
  nonemptyQueryIds: v.nullable(v.pipe(v.array(v.string()), v.minLength(1))),
  measurement: v.nullable(
    v.strictObject({
      runId: v.pipe(v.string(), v.regex(/^\d+$/u)),
      fixtureFingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
      outcomes: v.pipe(
        v.array(
          v.strictObject({
            id: v.string(),
            rank: v.nullable(
              v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
            ),
            match: v.nullable(v.picklist(["strict", "relaxed"])),
            nonempty: v.boolean(),
          }),
        ),
        v.length(16),
      ),
    }),
  ),
});
const baseline = v.parse(baselineSchema, fixtureBaseline);
export const STATUTE_RECALL_TOP5_FLOOR = baseline.top5Floor;
const fixtureFingerprint = hashSha256Hex(
  JSON.stringify([fixtureQueries, fixtureDocuments]),
);
const PROTECTED_RELAXED_QUERY_ID = "land-register-good-faith";
const protectedRelaxedQuery =
  fixtureQueries.find(({ id }) => id === PROTECTED_RELAXED_QUERY_ID) ??
  panic("Recall fixture is missing its protected relaxed-only query");

const documentSchema = v.object({
  id: v.string(),
  eli: v.string(),
  title: v.string(),
  status: v.picklist(["current", "historical"]),
  versionDate: v.string(),
  validTo: v.optional(v.nullable(v.string())),
  text: v.string(),
  sourceUrl: v.string(),
});
const VERSIONS = v
  .parse(v.array(documentSchema), fixtureDocuments)
  .map((document) => {
    // Stable identities keep document-ID tie breaking reproducible across CI runs.
    const documentIdentity = hashSha256Hex(`document:${document.id}`).slice(
      0,
      12,
    );
    const revisionIdentity = hashSha256Hex(`revision:${document.id}`).slice(
      0,
      12,
    );
    return {
      eli: document.eli,
      title: document.title,
      status: document.status,
      versionDate: document.versionDate,
      validTo: document.validTo,
      text: document.text,
      sourceUrl: document.sourceUrl,
      id: toSafeId<"legislationDocument">(
        `00000000-0000-7000-8000-${documentIdentity}`,
      ),
      revision: toSafeId<"corpusIndexProjectionIntent">(
        `00000000-0000-7000-8000-${revisionIdentity}`,
      ),
    };
  });

const canonicalWorkEli = (eli: string) => {
  const normalized = normalizeEli(eli, {
    hosts: { cz: "https://www.e-sbirka.cz" },
  });
  return normalized.ok
    ? normalized.value
    : panic("Recall fixture contains an invalid Work ELI");
};

// Git comparison binds the raise-only floor to the reviewed branch base.
const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
};
test("the committed statute recall floor and nonempty coverage only increase", () => {
  expect(fixtureQueries).toHaveLength(16);
  const queryIds = new Set(fixtureQueries.map(({ id }) => id));
  expect(queryIds.size).toBe(16);
  expect(new Set(fixtureDocuments.map(({ id }) => id)).size).toBe(
    fixtureDocuments.length,
  );
  expect(
    readStatuteQueryReferences("cze", protectedRelaxedQuery.query),
  ).toEqual([]);
  const fixtureWorks = new Set(
    fixtureDocuments.map(({ eli }) => canonicalWorkEli(eli)),
  );
  for (const { expectedActs } of fixtureQueries) {
    expect(expectedActs.length).toBeGreaterThan(0);
    for (const act of expectedActs) {
      expect(fixtureWorks.has(canonicalWorkEli(`cz/sb/${act}`))).toBe(true);
    }
  }
  for (const { text } of fixtureDocuments) {
    expect(text.trim().length).toBeGreaterThan(0);
  }
  if (baseline.nonemptyQueryIds !== null) {
    expect(new Set(baseline.nonemptyQueryIds).size).toBe(
      baseline.nonemptyQueryIds.length,
    );
    for (const id of baseline.nonemptyQueryIds) {
      expect(queryIds.has(id)).toBe(true);
    }
  }
  if (baseline.top5Floor !== null) {
    expect(
      baseline.measurement,
      "A measured floor requires its CI outcomes",
    ).not.toBeNull();
    expect(baseline.nonemptyQueryIds).not.toBeNull();
  }
  if (baseline.measurement !== null) {
    const { outcomes } = baseline.measurement;
    expect(baseline.measurement.fixtureFingerprint).toBe(fixtureFingerprint);
    expect(outcomes.map(({ id }) => id)).toEqual(
      fixtureQueries.map(({ id }) => id),
    );
    expect(baseline.top5Floor).toBe(
      outcomes.filter(({ rank }) => rank !== null && rank <= 5).length,
    );
    expect(baseline.nonemptyQueryIds).toEqual(
      outcomes.filter(({ nonempty }) => nonempty).map(({ id }) => id),
    );
    expect(baseline.nonemptyQueryIds).toContain(PROTECTED_RELAXED_QUERY_ID);
    for (const outcome of outcomes) {
      expect(outcome.rank === null).toBe(outcome.match === null);
      if (outcome.rank !== null) {
        expect(outcome.nonempty).toBe(true);
      }
    }
    const protectedOutcome = outcomes.find(
      ({ id }) => id === PROTECTED_RELAXED_QUERY_ID,
    );
    expect(protectedOutcome?.match).toBe("relaxed");
    expect(protectedOutcome?.rank).not.toBeNull();
  }
  // CI fetches only the target branch's base commit into its shallow checkout
  // and names it; a local checkout resolves it from origin/main.
  const base =
    process.env["STATUTE_RECALL_BASE_REF"] ??
    git(["merge-base", "origin/main", "HEAD"]);
  const previousPath = git([
    "ls-tree",
    "--full-tree",
    "--name-only",
    base,
    "--",
    BASELINE_PATH,
  ]);
  if (previousPath === "") {
    return;
  }
  const previous = v.parse(
    baselineSchema,
    JSON.parse(git(["show", `${base}:${BASELINE_PATH}`])),
  );
  if (previous.top5Floor !== null) {
    expect(STATUTE_RECALL_TOP5_FLOOR).not.toBeNull();
    if (STATUTE_RECALL_TOP5_FLOOR === null) {
      return;
    }
    expect(STATUTE_RECALL_TOP5_FLOOR).toBeGreaterThanOrEqual(
      previous.top5Floor,
    );
  }
  if (previous.nonemptyQueryIds !== null) {
    expect(baseline.nonemptyQueryIds).not.toBeNull();
    for (const id of previous.nonemptyQueryIds) {
      expect(baseline.nonemptyQueryIds).toContain(id);
    }
  }
});

describe.skipIf(!runEngineTests)(
  "official statute act-level recall against the pinned engine",
  () => {
    let databaseClient: PGlite | undefined;
    let legislationDb: LegislationReadDb;
    let restoreSearch: (() => void) | undefined;
    let fixtureIndexCreated = false;
    const nativeReads: { query: string; documentIds: unknown[] }[] = [];
    beforeAll(async () => {
      databaseClient = await createTestPglite();
      const db = drizzle({ client: databaseClient });
      legislationDb = async <T>(
        fn: (tx: LegislationReadTransaction) => Promise<T>,
      ) =>
        await withPublicLawReaderRole(
          db,
          async (roleTx) => await fn(asTestRaw(roleTx)),
        );
      await db.insert(legislationSources).values({
        id: sourceId,
        adapterKey: "statutes-open",
        name: "Official Czech statute excerpts",
      });
      await db.insert(legislationDocuments).values(
        VERSIONS.map((version) => ({
          id: version.id,
          sourceId,
          eli: version.eli,
          title: version.title,
          country: "CZE",
          language: "cs",
          documentType: "act",
          status: version.status,
          versionValidFrom: version.versionDate,
          versionValidTo: version.validTo ?? null,
          contentHash: FINGERPRINT,
        })),
      );
      await db.insert(corpusIndexGenerations).values({
        family: "legislation",
        generation: MANIFEST.generation,
        cluster: "q09",
        manifestDigest: corpusIndexManifestDigest(MANIFEST),
        status: "serving",
      });
      await db.insert(corpusIndexProjectionIntents).values(
        VERSIONS.map((version) => ({
          id: version.revision,
          family: "legislation" as const,
          generation: MANIFEST.generation,
          entityId: version.id,
          epoch: 1n,
          fingerprint: FINGERPRINT,
          indexId: SERVING_INDEX_ID,
          status: "applied" as const,
          appendStartedAt: new Date(),
          appendCommittedAt: new Date(),
          expectedDocumentCount: 1,
          appliedAt: new Date(),
        })),
      );
      await db.insert(corpusIndexProjectionStates).values(
        VERSIONS.map((version) => ({
          family: "legislation" as const,
          generation: MANIFEST.generation,
          entityId: version.id,
          desiredAction: "upsert" as const,
          desiredEpoch: 1n,
          desiredFingerprint: FINGERPRINT,
          desiredIndexId: SERVING_INDEX_ID,
          appliedAction: "upsert" as const,
          appliedEpoch: 1n,
          appliedRevision: version.revision,
          appliedFingerprint: FINGERPRINT,
          appliedIndexId: SERVING_INDEX_ID,
          appliedAt: new Date(),
        })),
      );

      const created = await corpusClient.createIndex(
        corpusIndexConfigFromManifest(MANIFEST, INDEX_ID),
        "unobserved",
      );
      if (created.isErr()) {
        throw created.error;
      }
      fixtureIndexCreated = true;
      const documents = VERSIONS.flatMap((version) => {
        const input = {
          family: "legislation",
          documentId: String(version.id),
          sourceId: String(sourceId),
          jurisdiction: "CZE",
          language: "cs",
          documentType: "act",
          contentHash: FINGERPRINT,
          redistributionEligible: true,
          title: version.title,
          status: version.status,
          effectiveDate: version.versionDate,
          versionValidFrom: version.versionDate,
          versionValidTo: version.validTo ?? null,
          eli: version.eli,
          ...EFFECTIVE_CONSOLIDATION,
        } satisfies LegislationV2ProjectionInput;
        const built = buildLegislationV2ProjectionDocuments({
          input,
          payload: { text: version.text, ast: null },
          revision: version.revision,
        });
        if (built.isErr()) {
          throw built.error;
        }
        return built.value;
      });
      const ingested = await corpusClient.ingestCommittedBatch(
        INDEX_ID,
        `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`,
        "unobserved",
      );
      if (ingested.isErr()) {
        throw ingested.error;
      }

      const originalSearch = corpusClient.search.bind(corpusClient);
      const searchSpy = spyOn(corpusClient, "search").mockImplementation(
        async (options) => {
          const result = await originalSearch({
            ...options,
            indexId: INDEX_ID,
          });
          if (result.isOk()) {
            nativeReads.push({
              query: options.query,
              documentIds: result.value.hits.map((hit) => hit["document_id"]),
            });
          }
          return result;
        },
      );
      restoreSearch = () => searchSpy.mockRestore();
    }, ENGINE_TIMEOUT_MS);

    afterAll(async () => {
      restoreSearch?.();
      const deleted = fixtureIndexCreated
        ? await corpusClient.deleteIndex(INDEX_ID, "unobserved")
        : null;
      await databaseClient?.close();
      if (deleted?.isErr()) {
        throw deleted.error;
      }
    }, ENGINE_TIMEOUT_MS);

    test(
      "the protected official passage is retrieved only through public relaxed search",
      async () => {
        expect(
          readStatuteQueryReferences("cze", protectedRelaxedQuery.query),
        ).toEqual([]);
        const expectedWorks = new Set(
          protectedRelaxedQuery.expectedActs.map((act) =>
            canonicalWorkEli(`cz/sb/${act}`),
          ),
        );
        const expectedDocumentIds = VERSIONS.filter(({ eli }) =>
          expectedWorks.has(canonicalWorkEli(eli)),
        ).map(({ id }) => String(id));
        expect(expectedDocumentIds.length).toBeGreaterThan(0);
        const definition = createPublicStatuteSearch(
          async (body, _publicDb, observability) =>
            await searchLegislationHandler(body, legislationDb, observability, {
              provider: "corpus-index",
              loadSearchConfigs: async () => [],
            }),
        );
        const app = new Elysia().get(
          "/law/statutes/search",
          definition.handler,
          {
            query: definition.config.query,
            response: definition.config.response,
          },
        );
        const url = new URL("http://localhost/law/statutes/search");
        url.searchParams.set("query", protectedRelaxedQuery.query);
        url.searchParams.set("country", "CZE");
        url.searchParams.set("limit", "10");
        const firstRead = nativeReads.length;
        const response = await app.handle(new Request(url.href));
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        if (!Value.Check(searchLegislationSuccessResponseSchema, body)) {
          panic("Protected public statute query returned an invalid response");
        }
        const reads = nativeReads.slice(firstRead);
        const strictClause = corpusFreeTextClause(protectedRelaxedQuery.query);
        expect(strictClause).not.toBeNull();
        if (strictClause === null) {
          panic("Protected query has no strict search clause");
        }
        expect(reads.at(0)?.query.startsWith(strictClause)).toBe(true);
        const strictReads = reads.filter(({ query }) =>
          query.startsWith(strictClause),
        );
        expect(strictReads.length).toBeGreaterThan(0);
        expect(
          strictReads
            .flatMap(({ documentIds }) => documentIds)
            .some((id) => expectedDocumentIds.includes(String(id))),
        ).toBe(false);
        const hit = body.items.find(({ eli }) =>
          expectedWorks.has(canonicalWorkEli(eli)),
        );
        expect(hit).toBeDefined();
        if (hit === undefined) {
          panic("Protected official passage was not retrieved");
        }
        expect(hit.match.type).toBe("relaxed");
        expect(hit.headline).not.toBeNull();
        expect(
          hit.headline?.replace(/<\/?mark>/gu, "").normalize("NFC"),
        ).toMatch(/dobr[éeá] (?:víře|víra)/u);
      },
      ENGINE_TIMEOUT_MS,
    );

    test(
      "public statute search preserves its measured top-five act recall and nonempty pages",
      async () => {
        const definition = createPublicStatuteSearch(
          async (body, _publicDb, observability) =>
            await searchLegislationHandler(body, legislationDb, observability, {
              provider: "corpus-index",
              loadSearchConfigs: async () => [],
            }),
        );
        const app = new Elysia().get(
          "/law/statutes/search",
          definition.handler,
          {
            query: definition.config.query,
            response: definition.config.response,
          },
        );
        const rows = [];
        for (const fixture of fixtureQueries) {
          const url = new URL("http://localhost/law/statutes/search");
          url.searchParams.set("query", fixture.query);
          url.searchParams.set("country", "CZE");
          url.searchParams.set("limit", "10");
          const response = await app.handle(new Request(url.href));
          expect(response.status, fixture.id).toBe(200);
          const body: unknown = await response.json();
          if (!Value.Check(searchLegislationSuccessResponseSchema, body)) {
            panic("Public statute eval returned an invalid search response");
          }
          const expected = new Set(
            fixture.expectedActs.map((act) => canonicalWorkEli(`cz/sb/${act}`)),
          );
          const index = body.items.findIndex((hit) =>
            expected.has(canonicalWorkEli(hit.eli)),
          );
          const expectedHit =
            index === -1
              ? null
              : (body.items.at(index) ??
                panic("Expected act rank has no corresponding hit"));
          rows.push({
            id: fixture.id,
            rank: index === -1 ? null : index + 1,
            match: expectedHit === null ? null : expectedHit.match.type,
            nonempty: body.items.length > 0,
          });
        }
        const top5 = rows.filter(
          ({ rank }) => rank !== null && rank <= 5,
        ).length;
        const top1 = rows.filter(({ rank }) => rank === 1).length;
        const nonemptyQueryIds = rows
          .filter(({ nonempty }) => nonempty)
          .map(({ id }) => id);
        const emptyRegressions = rows.filter(
          ({ id, nonempty }) =>
            !nonempty && baseline.nonemptyQueryIds?.includes(id),
        );
        console.info(
          `Statute act recall: top5=${top5}/16; top1=${top1}/16 (reported only)`,
        );
        if (
          STATUTE_RECALL_TOP5_FLOOR === null ||
          baseline.nonemptyQueryIds === null ||
          baseline.measurement === null ||
          baseline.measurement.fixtureFingerprint !== fixtureFingerprint ||
          top5 !== STATUTE_RECALL_TOP5_FLOOR ||
          emptyRegressions.length > 0
        ) {
          console.table(
            rows.map(({ id, rank, match }) => ({ id, rank, match })),
          );
          console.info(
            `Measured baseline: ${JSON.stringify({
              top5Floor: top5,
              nonemptyQueryIds,
              measurement: {
                runId:
                  process.env["GITHUB_RUN_ID"] ??
                  panic("Measure statute recall in CI"),
                fixtureFingerprint,
                outcomes: rows,
              },
            })}`,
          );
        }
        expect(
          STATUTE_RECALL_TOP5_FLOOR,
          "Measure and commit the statute recall baseline before publication",
        ).not.toBeNull();
        expect(
          baseline.nonemptyQueryIds,
          "Commit measured nonempty query IDs before publication",
        ).not.toBeNull();
        expect(
          baseline.measurement,
          "Commit the measured CI outcomes with the floor",
        ).not.toBeNull();
        expect(top5).toBeGreaterThan(0);
        expect(nonemptyQueryIds.length).toBeGreaterThan(0);
        if (STATUTE_RECALL_TOP5_FLOOR === null) {
          return;
        }
        expect(top5).toBeGreaterThanOrEqual(STATUTE_RECALL_TOP5_FLOOR);
        expect(emptyRegressions.map(({ id }) => id)).toEqual([]);
        if (top5 > STATUTE_RECALL_TOP5_FLOOR) {
          console.info(`Raise STATUTE_RECALL_TOP5_FLOOR to ${top5}.`);
        }
      },
      ENGINE_TIMEOUT_MS,
    );
  },
);
