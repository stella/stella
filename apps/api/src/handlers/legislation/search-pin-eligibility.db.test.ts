import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { STATUTE_ALIASES } from "@stll/api-contract/statute-aliases";
import type { StatuteAliasTarget } from "@stll/api-contract/statute-aliases";

import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSearchDocuments,
  legislationSources,
} from "@/api/db/schema";
import {
  rehydrateLegislationCandidates,
  searchLegislationHandler,
} from "@/api/handlers/legislation/search";
import { createSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { readNamedLegislationWorks } from "@/api/lib/legal-search/legislation-work-names";
import type { NamedLegislationWork } from "@/api/lib/legal-search/legislation-work-names";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const GENERATION = "legislation_v2";
const INDEX_ID = corpusIndexId(GENERATION, "CZE");
const FINGERPRINT = "b".repeat(64);
const DB_TEST_TIMEOUT_MS = 120_000;
const openSourceId = createSafeId<"legislationSource">();
const restrictedSourceId = createSafeId<"legislationSource">();
const revokedSourceId = createSafeId<"legislationSource">();

const descriptor = (allowsRedistribution: boolean) => ({
  license: "fixture-license",
  attribution: null,
  allowsRedistribution,
  allowsDerivedAi: false,
});

const act = (target: StatuteAliasTarget, country = "CZE") => ({
  id: createSafeId<"legislationDocument">(),
  sourceId: openSourceId,
  // Keep the collection tail identical across countries so country, rather
  // than an incidental ELI spelling difference, must separate the pair.
  eli: `https://example.test/eli/${country.toLowerCase()}/${target.collection}/${target.year}/${target.number}`,
  title: `${target.number}/${target.year} Sb., ${target.label}`,
  country,
  language: "cs",
  versionValidFrom: "2020-01-01",
  contentHash: `pin-${country}-${target.number}-${target.year}`,
});

const withdrawn = {
  ...act(STATUTE_ALIASES.cze.oz),
  windowDisposition: "withdrawn",
  windowDispositionBasis: "publisher-unlisted",
} as const satisfies typeof legislationDocuments.$inferInsert;
const restricted = {
  ...act(STATUTE_ALIASES.cze.zp),
  sourceId: restrictedSourceId,
};
const foreign = act(STATUTE_ALIASES.cze.zok, "SVK");
const revoked = {
  ...act(STATUTE_ALIASES.cze.trz),
  sourceId: revokedSourceId,
};
const domesticPair = act(STATUTE_ALIASES.cze.osr);
const foreignPair = act(STATUTE_ALIASES.cze.osr, "SVK");
const amendment = {
  id: createSafeId<"legislationDocument">(),
  sourceId: openSourceId,
  eli: "https://example.test/eli/cze/sb/2024/999",
  title: "999/2024 Sb., kterým se mění některé zákony",
  country: "CZE",
  language: "cs",
  versionValidFrom: "2024-01-01",
  contentHash: "pin-eligible-amendment",
};

const cases = [
  {
    reason: "withdrawn",
    alias: "OZ",
    target: STATUTE_ALIASES.cze.oz,
    document: withdrawn,
    namedElis: [withdrawn.eli],
    shown: [amendment],
  },
  {
    reason: "restricted source",
    alias: "ZP",
    target: STATUTE_ALIASES.cze.zp,
    document: restricted,
    namedElis: [],
    shown: [amendment],
  },
  {
    reason: "other country",
    alias: "ZOK",
    target: STATUTE_ALIASES.cze.zok,
    document: foreign,
    namedElis: [],
    shown: [amendment],
  },
  {
    reason: "redistribution revoked after projection",
    alias: "TrZ",
    target: STATUTE_ALIASES.cze.trz,
    document: revoked,
    namedElis: [],
    shown: [amendment],
  },
  {
    reason: "same-number CZE/SVK pair",
    alias: "OSŘ",
    target: STATUTE_ALIASES.cze.osr,
    document: foreignPair,
    namedElis: [domesticPair.eli],
    shown: [domesticPair, amendment],
  },
];
const queriesFor = ({
  alias,
  target,
}: {
  alias: string;
  target: StatuteAliasTarget;
}) => [`${target.number}/${target.year} Sb.`, alias];
const documents = [
  withdrawn,
  restricted,
  foreign,
  revoked,
  domesticPair,
  foreignPair,
  amendment,
];
const candidates = [{ id: String(amendment.id), score: 0.9 }];

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let legislationDb: LegislationReadDb;
const namesBeforeRevocation = new Map<string, NamedLegislationWork[]>();

const readNames = async (query: string) =>
  await legislationDb(
    async (tx) =>
      await readNamedLegislationWorks(tx, { query, country: "CZE" }),
  );

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    legislationDb = async <T>(
      fn: (tx: LegislationReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(db, async (tx) => await fn(asTestRaw(tx)));
    await db.insert(legislationSources).values([
      { id: openSourceId, adapterKey: "pin-open", name: "Open pin fixture" },
      {
        id: restrictedSourceId,
        adapterKey: "pin-restricted",
        name: "Restricted pin fixture",
        descriptor: descriptor(false),
      },
      {
        id: revokedSourceId,
        adapterKey: "pin-revoked",
        name: "Revoked pin fixture",
        descriptor: descriptor(true),
      },
    ]);
    await db.insert(legislationDocuments).values(documents);
    await db.execute(
      sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
    );
    // Only the amendment has a lexical projection. Its wording mentions each
    // query, so a named act can enter either path only through pinning.
    const searchableText = `${amendment.title} ${cases.flatMap(queriesFor).join(" ")}`;
    await db.insert(legislationSearchDocuments).values({
      documentId: amendment.id,
      title: amendment.title,
      searchableText,
      language: "cs",
      regconfig: "simple",
      tsv: sql`to_tsvector('simple', ${searchableText})`,
    });
    await db.insert(corpusIndexGenerations).values({
      family: "legislation",
      generation: GENERATION,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS[GENERATION],
      ),
      status: "building",
    });
    const intents = documents.map(({ id }) => ({
      id: createSafeId<"corpusIndexProjectionIntent">(),
      entityId: id,
    }));
    const projectedAt = new Date("2026-01-01T00:00:00Z");
    await db.insert(corpusIndexProjectionIntents).values(
      intents.map(({ id, entityId }) => ({
        id,
        entityId,
        family: "legislation" as const,
        generation: GENERATION,
        epoch: 1n,
        fingerprint: FINGERPRINT,
        indexId: INDEX_ID,
        status: "applied" as const,
        appendStartedAt: projectedAt,
        appendCommittedAt: projectedAt,
        expectedDocumentCount: 1,
        appliedAt: projectedAt,
      })),
    );
    await db.insert(corpusIndexProjectionStates).values(
      intents.map(({ id, entityId }) => ({
        family: "legislation" as const,
        generation: GENERATION,
        entityId,
        desiredAction: "upsert" as const,
        desiredEpoch: 1n,
        desiredFingerprint: FINGERPRINT,
        desiredIndexId: INDEX_ID,
        appliedAction: "upsert" as const,
        appliedEpoch: 1n,
        appliedRevision: id,
        appliedFingerprint: FINGERPRINT,
        appliedIndexId: INDEX_ID,
        appliedAt: projectedAt,
      })),
    );
    for (const query of queriesFor({
      alias: "TrZ",
      target: STATUTE_ALIASES.cze.trz,
    })) {
      // db-await-in-loop: capture each real query's names before permission changes.
      const named = await readNames(query);
      expect(named.map(({ eli }) => eli)).toEqual([revoked.eli]);
      namesBeforeRevocation.set(query, named);
    }
    await db
      .update(legislationSources)
      .set({ descriptor: descriptor(false) })
      .where(eq(legislationSources.id, revokedSourceId));
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

const searchDependencies = {
  provider: "pg-fts",
  loadSearchConfigs: async () => [
    {
      regconfig: "simple",
      useUnaccent: false,
      includeDefault: true,
      languages: [],
    },
  ],
} satisfies NonNullable<Parameters<typeof searchLegislationHandler>[3]>;

describe("unscanned named acts obey current public eligibility", () => {
  test.each(
    cases.flatMap((entry) =>
      queriesFor(entry).map((query) => ({
        reason: entry.reason,
        document: entry.document,
        namedElis: entry.namedElis,
        shown: entry.shown,
        query,
      })),
    ),
  )(
    "$reason: $query admits only eligible pins and the scanned amendment",
    async ({ document, namedElis, shown, query }) => {
      expect(candidates.map(({ id }) => id)).toEqual([String(amendment.id)]);
      expect(candidates.some(({ id }) => id === String(document.id))).toBe(
        false,
      );
      const stored = await legislationDb(
        async (tx) =>
          await tx
            .select({
              id: legislationDocuments.id,
              country: legislationDocuments.country,
            })
            .from(legislationDocuments)
            .where(eq(legislationDocuments.id, document.id)),
      );
      expect(stored).toEqual([{ id: document.id, country: document.country }]);
      expect((await readNames(query)).map(({ eli }) => eli)).toEqual(namedElis);

      const expectedIds = shown.map(({ id }) => String(id));
      const result = await rehydrateLegislationCandidates({
        body: { query, jurisdiction: "CZE" },
        candidates,
        generation: GENERATION,
        legislationDb,
      });
      expect(result.ranked.map(({ id }) => id)).toEqual(expectedIds);
      expect([...result.context.byId.keys()].toSorted()).toEqual(
        expectedIds.toSorted(),
      );

      const response = await searchLegislationHandler(
        { query, jurisdiction: "CZE", limit: 10 },
        legislationDb,
        "unobserved",
        searchDependencies,
      );
      if (!("items" in response)) {
        panic("pin eligibility search rejected its query");
      }
      expect(response.items.map(({ documentId }) => documentId)).toEqual(
        expectedIds,
      );
      expect(response.items.map(({ eli }) => eli)).toEqual(
        shown.map(({ eli }) => eli),
      );
      expect(
        response.items.every(
          ({ country, match }) => country === "CZE" && match.type === "strict",
        ),
      ).toBe(true);
      expect(response.nextCursor).toBeNull();
    },
  );

  test.each(queriesFor({ alias: "TrZ", target: STATUTE_ALIASES.cze.trz }))(
    "permission revoked after names were read excludes the cached pin for %s",
    async (query) => {
      const namedWorks =
        namesBeforeRevocation.get(query) ??
        panic("missing pre-revocation names");
      expect(namedWorks.map(({ eli }) => eli)).toEqual([revoked.eli]);
      const projection = await db
        .select({ appliedAction: corpusIndexProjectionStates.appliedAction })
        .from(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, revoked.id));
      expect(projection).toEqual([{ appliedAction: "upsert" }]);
      const result = await rehydrateLegislationCandidates({
        body: { query, jurisdiction: "CZE" },
        candidates,
        generation: GENERATION,
        legislationDb,
        namedWorks,
      });
      expect(result.ranked.map(({ id }) => id)).toEqual([String(amendment.id)]);
      expect([...result.context.byId.keys()]).toEqual([String(amendment.id)]);
    },
  );
});
