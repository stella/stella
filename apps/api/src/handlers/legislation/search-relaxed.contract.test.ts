import type { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import {
  PUBLIC_COUNTRY_UNAVAILABLE_CODE,
  PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
} from "@stll/api-contract/public-country-capability";
import { assertProperty } from "@stll/property-testing";

import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { searchLegislationHandler } from "@/api/handlers/legislation/search";
import type { SearchLegislationBody } from "@/api/handlers/legislation/search-schema";
import { createSafeId } from "@/api/lib/branded-types";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { HIGHLIGHT_COPIES_PER_PASSAGE } from "@/api/lib/legal-search/corpus-index-pagination";
import { buildLegislationV2ProjectionDocuments } from "@/api/lib/legal-search/corpus-index-projection-builder";
import type { LegislationV2ProjectionInput } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { corpusFreeTextClause } from "@/api/lib/legal-search/corpus-query";
import {
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { relaxedLegislationClause } from "@/api/lib/legal-search/legislation-query";
import { publicLawCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { encodeCursor } from "@/api/lib/search/cursor";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

// This contract uses Quickwit 0.9's real native search and snippets. Only its
// index name is redirected; canonical metadata and Work collapse use PGlite.
const runEngineTests = process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] === "true";
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
const INDEX_ID = `legislation_v2_contract_${Date.now().toString(36)}`;
const SERVING_INDEX_ID = corpusIndexId(MANIFEST.generation, "CZE");
const ENGINE_TIMEOUT_MS = 120_000;
const FINGERPRINT = "a".repeat(64);
const QUERY = "smlouva náhrada";
const sourceId = createSafeId<"legislationSource">();
const differentSourceId = createSafeId<"legislationSource">();
const corpusClient = getCorpusIndexClient("q09");

type RequestFilters = Omit<SearchLegislationBody, "query" | "limit" | "cursor">;

const PRESENT_FILTERS = {
  jurisdiction: "CZE",
  documentType: "act",
  status: "current",
  source: sourceId,
  language: "cs",
  dateFrom: "1999-01-01",
  dateTo: "2030-01-01",
} as const satisfies Required<RequestFilters>;

const DIFFERENT_FILTERS = {
  jurisdiction: { jurisdiction: "SVK" },
  documentType: { documentType: "regulation" },
  status: { status: "repealed" },
  source: { source: differentSourceId },
  language: { language: "sk" },
  dateFrom: { dateFrom: "1998-01-01" },
  dateTo: { dateTo: "2031-01-01" },
} as const satisfies {
  [Field in keyof RequestFilters]-?: Required<Pick<RequestFilters, Field>>;
};

// A second admission lets the fingerprint boundary be tested independently of
// today's public capability gate, whose pending-country response is checked too.
const admittedFixtureCountries = {
  unavailable: (country: string) =>
    country === "CZE" || country === "SVK"
      ? null
      : publicLawCountryUnavailable(country),
  isAdmitted: (country: string) => country === "CZE" || country === "SVK",
};

type FixtureVersionOptions = {
  tail: string;
  title: string;
  text: string;
  validFrom?: string;
  validTo?: string | null;
};

const fixtureVersion = ({
  tail,
  title,
  text,
  validFrom = "2024-01-01",
  validTo = null,
}: FixtureVersionOptions) => ({
  id: createSafeId<"legislationDocument">(),
  revision: createSafeId<"corpusIndexProjectionIntent">(),
  eli: `https://example.test/eli/cz/sb/${tail}`,
  title,
  text,
  validFrom,
  validTo,
});

const strictOld = fixtureVersion({
  tail: "2000/501",
  title: "Smluvní pravidla",
  text: "Smlouva náhrada škody podle § 2051.",
  validFrom: "2000-01-01",
  validTo: "2024-01-01",
});
const strictCurrent = fixtureVersion({
  tail: "2000/501",
  title: "Smluvní pravidla",
  text: "Smlouva náhrada škody podle § 2051.",
});
const amendment = fixtureVersion({
  tail: "2013/303",
  title: "303/2013 Sb., kterým se mění zákon č. 89/2012 Sb., občanský zákoník",
  text: "Smlouva náhrada škody podle § 2051 občanského zákoníku.",
});
const code = fixtureVersion({
  tail: "2012/89",
  title: "89/2012 Sb., občanský zákoník",
  text: "Občanský zákoník stanoví pravidla podle § 2051.",
});
const relaxedVersions = Array.from({ length: 7 }, (_, index) =>
  fixtureVersion({
    tail: `2001/${String(601 + index)}`,
    title: `Pravidla plnění ${String(index + 1)}`,
    text:
      index % 2 === 0
        ? "Smlouva upravuje plnění podle § 2051."
        : "Náhrada škody se posuzuje podle § 2051.",
  }),
);
const cappedStrictVersions = Array.from(
  {
    length:
      LIMITS.corpusIndexSearchCandidateLimit *
        LIMITS.corpusIndexSearchMaxRounds +
      1,
  },
  (_, index) =>
    fixtureVersion({
      tail: "2002/701",
      title: "Pravidla závazků",
      text: "Závazek pohledávka patří do právního vztahu.",
      validFrom: new Date(Date.UTC(2002, 0, index + 1))
        .toISOString()
        .slice(0, 10),
    }),
);
const VERSIONS = [
  strictOld,
  strictCurrent,
  amendment,
  code,
  ...relaxedVersions,
  ...cappedStrictVersions,
];

describe.skipIf(!runEngineTests)(
  "legislation recall against the pinned engine",
  () => {
    let databaseClient: PGlite | undefined;
    let legislationDb: LegislationReadDb;
    let restoreSearch: (() => void) | undefined;
    let fixtureIndexCreated = false;
    const searchCalls: Parameters<typeof corpusClient.search>[0][] = [];

    beforeAll(async () => {
      expect(
        new Set(cappedStrictVersions.map((version) => version.eli)).size,
      ).toBe(1);
      expect(
        new Set(cappedStrictVersions.map((version) => version.validFrom)).size,
      ).toBe(cappedStrictVersions.length);
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
        name: "Open contract fixture",
      });
      const documentsSeeded = await Result.tryPromise(
        async () =>
          await db.insert(legislationDocuments).values(
            VERSIONS.map((version) => ({
              id: version.id,
              sourceId,
              eli: version.eli,
              title: version.title,
              country: "CZE",
              language: "cs",
              documentType: "act",
              status: "current",
              effectiveDate: version.validFrom,
              versionValidFrom: version.validFrom,
              versionValidTo: version.validTo,
              contentHash: FINGERPRINT,
            })),
          ),
      );
      if (documentsSeeded.isErr()) {
        const cause = documentsSeeded.error.cause;
        // Surface the driver cause before the large fixture SQL can truncate it.
        if (cause instanceof DrizzleQueryError && cause.cause !== undefined) {
          throw cause.cause;
        }
        throw documentsSeeded.error;
      }
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
          status: "current",
          effectiveDate: version.validFrom,
          versionValidFrom: version.validFrom,
          versionValidTo: version.validTo,
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
          searchCalls.push(options);
          return await originalSearch({ ...options, indexId: INDEX_ID });
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

    const search = async (
      body: SearchLegislationBody,
      dependencies?: Parameters<typeof searchLegislationHandler>[3],
    ) => {
      const result = await searchLegislationHandler(
        body,
        legislationDb,
        "unobserved",
        dependencies ?? {
          provider: "corpus-index",
          loadSearchConfigs: async () => [],
        },
      );
      return "items" in result
        ? result
        : panic("contract search refused a valid request");
    };

    test.each([
      "Výklad zákona č. 89/2012 Sb. při náhradě škody",
      "Výklad OZ při náhradě škody",
      "Vyklad NOZ pri nahrade skody",
    ])(
      "an embedded citation or alias in %s pins the act ahead of its amendment",
      async (query) => {
        const result = await search({ query, jurisdiction: "CZE", limit: 10 });
        expect(result.items.at(0)).toMatchObject({
          documentId: String(code.id),
          match: { type: "strict" },
        });
        expect(result.items.map((hit) => hit.documentId)).toContain(
          String(amendment.id),
        );
      },
    );

    test("a short exhausted strict page appends relaxed hits and highlights only emitted passages", async () => {
      const callStart = searchCalls.length;
      const result = await search({
        query: QUERY,
        jurisdiction: "CZE",
        limit: 3,
      });
      const calls = searchCalls.slice(callStart);

      expect(result.items.map((hit) => hit.match.type)).toEqual([
        "strict",
        "strict",
        "relaxed",
      ]);
      const relaxedCalls = calls.filter(
        (call) =>
          !/\b(?:document_id|chunk_id):/u.test(call.query) &&
          call.query.startsWith('("smlouva" OR "náhrada")'),
      );
      expect(relaxedCalls).toHaveLength(1);
      expect(relaxedCalls.at(0)?.snippetFields).toBeUndefined();
      const highlights = calls.filter((call) =>
        call.snippetFields?.includes("text"),
      );
      expect(highlights).toHaveLength(2);
      for (const highlight of highlights) {
        expect(/\b(?:document_id|chunk_id):/u.test(highlight.query)).toBe(true);
        expect(highlight.maxHits).toBeLessThanOrEqual(
          result.items.length * HIGHLIGHT_COPIES_PER_PASSAGE,
        );
      }
      expect(calls).toHaveLength(4);
      expect(result.nextCursor).not.toBeNull();
      const cursor = decodeCorpusSearchCursor(
        result.nextCursor ?? panic("relaxed page has no continuation"),
      );
      expect(cursor?.phase?.type).toBe("relaxed");
      expect(cursor?.phase?.generation).toBe(MANIFEST.generation);
      if (cursor?.phase?.type !== "relaxed") {
        panic("short exhausted fixture did not produce a relaxed cursor");
      }
      expect(cursor.phase.strictWorkTokens).toHaveLength(2);
      expect(
        cursor.phase.strictWorkTokens.some((token) =>
          cursor.excludedGroups?.includes(token),
        ),
      ).toBe(false);
    });

    test("a short first strict page with a continuation defers relaxation", async () => {
      const callStart = searchCalls.length;
      const result = await search({
        query: "závazek pohledávka",
        jurisdiction: "CZE",
        limit: 3,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items.length).toBeLessThan(3);
      expect(result.items.at(0)?.match.type).toBe("strict");
      const cursor = decodeCorpusSearchCursor(
        result.nextCursor ??
          panic("capped strict fixture did not reach a continuation"),
      );
      expect(cursor?.phase?.type).toBe("strict");
      expect(cursor?.windowStart).toBe(
        LIMITS.corpusIndexSearchCandidateLimit *
          LIMITS.corpusIndexSearchMaxRounds,
      );
      const scans = searchCalls
        .slice(callStart)
        .filter((call) => !/\b(?:document_id|chunk_id):/u.test(call.query));
      expect(scans).toHaveLength(LIMITS.corpusIndexSearchMaxRounds);
      expect(
        scans.every((call) =>
          call.query.startsWith('("závazek" AND "pohledávka")'),
        ),
      ).toBe(true);
    });

    test("a full strict page never invokes the relaxed pass", async () => {
      const callStart = searchCalls.length;
      const result = await search({
        query: QUERY,
        jurisdiction: "CZE",
        limit: 1,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items.every((hit) => hit.match.type === "strict")).toBe(
        true,
      );
      const calls = searchCalls.slice(callStart);
      expect(calls).toHaveLength(2);
      expect(
        calls.filter(
          (call) =>
            call.snippetFields?.includes("text") &&
            !/\b(?:document_id|chunk_id):/u.test(call.query),
        ),
      ).toHaveLength(0);
      const cursor = decodeCorpusSearchCursor(
        result.nextCursor ?? panic("strict page has no continuation"),
      );
      expect(cursor?.phase?.type).toBe("strict");
    });

    test.each([1, 3])(
      "a strict continuation stays strict when the final page has limit %s",
      async (limit) => {
        const first = await search({
          query: QUERY,
          jurisdiction: "CZE",
          limit: 1,
        });
        const cursor =
          first.nextCursor ?? panic("full strict page has no continuation");
        expect(decodeCorpusSearchCursor(cursor)?.phase?.type).toBe("strict");
        const callStart = searchCalls.length;
        const last = await search({
          query: QUERY,
          jurisdiction: "CZE",
          limit,
          cursor,
        });

        expect(last.items).toHaveLength(1);
        expect(last.nextCursor).toBeNull();
        const hits = [...first.items, ...last.items];
        expect(hits.every((hit) => hit.match.type === "strict")).toBe(true);
        expect(hits.map((hit) => hit.documentId).toSorted()).toEqual(
          [String(strictCurrent.id), String(amendment.id)].toSorted(),
        );
        expect(
          searchCalls
            .slice(callStart)
            .filter(
              (call) =>
                call.snippetFields?.includes("text") &&
                !/\b(?:document_id|chunk_id):/u.test(call.query),
            ),
        ).toHaveLength(0);
      },
    );

    test("snippets retain the section sign adjacent to the matched designation", async () => {
      const result = await search({
        query: "2051",
        jurisdiction: "CZE",
        limit: 20,
      });
      expect(result.items.some((hit) => hit.headline?.includes("§"))).toBe(
        true,
      );
    });

    test.each(["1.1.2024 50 000 42", "jak musí být a nebo"])(
      "an exhausted strict query %s with no relaxed terms returns no unrelated coverage",
      async (query) => {
        const unrelated = await search({
          query: QUERY,
          jurisdiction: "CZE",
          limit: 1,
        });
        expect(unrelated.items.at(0)?.match.type).toBe("strict");
        expect(
          unrelated.items.some((hit) =>
            [String(strictCurrent.id), String(amendment.id)].includes(
              hit.documentId,
            ),
          ),
        ).toBe(true);

        const body = { query, jurisdiction: "CZE", limit: 3 };
        expect(relaxedLegislationClause(body)).toBeNull();
        const strictClause =
          corpusFreeTextClause(query) ?? panic("fixture has no strict terms");
        const callStart = searchCalls.length;
        const result = await search(body);
        expect(result.items).toEqual([]);
        expect(result.nextCursor).toBeNull();
        const calls = searchCalls.slice(callStart);
        expect(calls).toHaveLength(1);
        expect(calls.at(0)?.query.startsWith(`${strictClause} AND `)).toBe(
          true,
        );
        expect(calls.at(0)?.snippetFields).toBeUndefined();
      },
    );

    test(
      "paging visits every Work once and strict hits precede relaxed hits",
      async () => {
        await assertProperty(
          "paging visits every Work once and strict hits precede relaxed hits",
          fc.asyncProperty(fc.integer({ min: 3, max: 6 }), async (limit) => {
            const shown: { eli: string; type: string }[] = [];
            let cursor: string | undefined;
            for (const _page of VERSIONS) {
              // db-await-in-loop: a continuation depends on the preceding page's cursor
              const result = await search({
                query: QUERY,
                jurisdiction: "CZE",
                limit,
                ...(cursor === undefined ? {} : { cursor }),
              });
              shown.push(
                ...result.items.map((hit) => ({
                  eli: hit.eli,
                  type: hit.match.type,
                })),
              );
              if (result.nextCursor === null) {
                cursor = undefined;
                break;
              }
              cursor = result.nextCursor;
            }
            expect(cursor).toBeUndefined();
            const expected = [strictCurrent, amendment, ...relaxedVersions]
              .map((version) => version.eli)
              .toSorted();
            expect(shown.map((hit) => hit.eli).toSorted()).toEqual(expected);
            expect(new Set(shown.map((hit) => hit.eli)).size).toBe(
              shown.length,
            );
            const firstRelaxed = shown.findIndex(
              (hit) => hit.type === "relaxed",
            );
            expect(firstRelaxed).toBe(2);
            expect(
              shown.slice(firstRelaxed).every((hit) => hit.type === "relaxed"),
            ).toBe(true);
          }),
          { numRuns: 8 },
        );
      },
      ENGINE_TIMEOUT_MS,
    );

    test("malformed, stale, and foreign query or phase cursors return the typed 400 without an engine search", async () => {
      const page = await search({
        query: QUERY,
        jurisdiction: "CZE",
        limit: 3,
      });
      const cursor = decodeCorpusSearchCursor(
        page.nextCursor ?? panic("fixture has no phase cursor"),
      );
      if (cursor?.phase?.type !== "relaxed") {
        panic("fixture did not reach the relaxed phase");
      }
      const { phase } = cursor;
      const invalid = [
        "malformed-cursor",
        encodeCursor(
          0.5,
          `0:none:relevance:p${Buffer.from('{"type":"strict').toString("base64url")}:${String(code.id)}`,
        ),
        encodeCorpusSearchCursor({
          ...cursor,
          phase: {
            type: "relaxed",
            fingerprint: "b".repeat(64),
            generation: phase.generation,
            strictWorkTokens: phase.strictWorkTokens,
          },
        }),
        encodeCorpusSearchCursor({
          ...cursor,
          phase: {
            type: "relaxed",
            fingerprint: phase.fingerprint,
            generation: "legislation_v1",
            strictWorkTokens: phase.strictWorkTokens,
          },
        }),
        encodeCorpusSearchCursor({
          ...cursor,
          dictionary: { type: "dictionary", contentHash: "c".repeat(64) },
        }),
      ];
      const callStart = searchCalls.length;
      for (const invalidCursor of invalid) {
        // db-await-in-loop: each malformed cursor has its own boundary response
        const response = await searchLegislationHandler(
          {
            query: QUERY,
            jurisdiction: "CZE",
            limit: 3,
            cursor: invalidCursor,
          },
          legislationDb,
          "unobserved",
          { provider: "corpus-index", loadSearchConfigs: async () => [] },
        );
        expect(response).toMatchObject({
          code: 400,
          response: { message: "Invalid cursor" },
        });
      }
      expect(searchCalls.length).toBe(callStart);
    });

    test.each(["strict", "relaxed"] as const)(
      "%s cursors reject every changed request filter before engine work",
      async (phase) => {
        const dependencies = {
          provider: "corpus-index",
          loadSearchConfigs: async () => [],
          countryAdmission: admittedFixtureCountries,
        } as const satisfies NonNullable<
          Parameters<typeof searchLegislationHandler>[3]
        >;
        const variants = [
          {
            filters: {},
            changes: Object.entries(PRESENT_FILTERS).map(([field, value]) => ({
              [field]: value,
            })),
          },
          {
            filters: PRESENT_FILTERS,
            changes: Object.values(DIFFERENT_FILTERS),
          },
        ];
        for (const { filters, changes: filterChanges } of variants) {
          const body = {
            query: QUERY,
            ...filters,
            limit: phase === "strict" ? 1 : 3,
          } satisfies SearchLegislationBody;
          // db-await-in-loop: each request shape must issue its own real cursor
          const page = await search(body, dependencies);
          const cursor = page.nextCursor ?? panic("fixture issued no cursor");
          expect(decodeCorpusSearchCursor(cursor)?.phase?.type).toBe(phase);

          const controlStart = searchCalls.length;
          // db-await-in-loop: controls reuse this exact issued cursor
          const control = await search({ ...body, cursor }, dependencies);
          expect(control.items.length).toBeGreaterThan(0);
          expect(searchCalls.length).toBeGreaterThan(controlStart);
          const resizedStart = searchCalls.length;
          // db-await-in-loop: page size is deliberately outside the fingerprint
          const resized = await search(
            { ...body, cursor, limit: 2 },
            dependencies,
          );
          expect(resized.items.length).toBeGreaterThan(0);
          expect(searchCalls.length).toBeGreaterThan(resizedStart);

          const changes = [{ query: "náhrada smlouva" }, ...filterChanges];
          for (const change of changes) {
            const callStart = searchCalls.length;
            // db-await-in-loop: assert each mutation's own typed boundary response
            const response = await searchLegislationHandler(
              { ...body, ...change, cursor },
              legislationDb,
              "unobserved",
              dependencies,
            );
            expect(response).toMatchObject({
              code: 400,
              response: { message: "Invalid cursor" },
            });
            expect(searchCalls.length).toBe(callStart);
          }
        }
      },
      ENGINE_TIMEOUT_MS,
    );

    test("an actual strict cursor rejects a changed serving generation before engine work", async () => {
      const body = { query: QUERY, jurisdiction: "CZE", limit: 1 };
      const page = await search(body);
      const cursor =
        page.nextCursor ?? panic("fixture issued no strict cursor");
      expect(decodeCorpusSearchCursor(cursor)?.phase?.type).toBe("strict");
      const control = await search({ ...body, cursor });
      expect(control.items.length).toBeGreaterThan(0);

      const callStart = searchCalls.length;
      const response = await searchLegislationHandler(
        { ...body, cursor },
        legislationDb,
        "unobserved",
        {
          provider: "corpus-index",
          loadSearchConfigs: async () => [],
          readServingGeneration: async (tx, family) =>
            (await readServingCorpusIndexGenerationTx(tx, family)).map(
              (serving) => ({
                ...serving,
                generation: CORPUS_INDEX_MANIFESTS.case_law_v7.generation,
              }),
            ),
        },
      );
      expect(response).toMatchObject({
        code: 400,
        response: { message: "Invalid cursor" },
      });
      expect(searchCalls.length).toBe(callStart);
    });

    test("a real cursor for a pending country returns capability unavailability before fingerprint comparison", async () => {
      const page = await search({
        query: QUERY,
        jurisdiction: "CZE",
        limit: 1,
      });
      const cursor =
        page.nextCursor ?? panic("fixture issued no strict cursor");
      const callStart = searchCalls.length;
      const response = await searchLegislationHandler(
        { query: QUERY, jurisdiction: "SVK", limit: 1, cursor },
        legislationDb,
        "unobserved",
        { provider: "corpus-index", loadSearchConfigs: async () => [] },
      );
      expect(response).toMatchObject({
        code: PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
        response: {
          code: PUBLIC_COUNTRY_UNAVAILABLE_CODE,
          country: "SVK",
          reason: "pending_public",
        },
      });
      expect(searchCalls.length).toBe(callStart);
    });
  },
);
