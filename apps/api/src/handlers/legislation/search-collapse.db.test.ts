import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { rehydrateLegislationCandidates } from "@/api/handlers/legislation/search";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { isAfterSearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import {
  inForceToday,
  isCurrentVersionOfWork,
  legislationVersionRef,
} from "@/api/lib/legal-search/legislation-validity-window";
import { syncLegislationWorkNamesTx } from "@/api/lib/legal-search/legislation-work-names";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * A legislation search shows each act once, as the version that applies
 * today, and places the acts a query names first. These tests hold that
 * reading against stored versions, windows and titles.
 */

const GENERATION = "legislation_v2";
const INDEX_ID = corpusIndexId(GENERATION, "CZE");
const FINGERPRINT = "a".repeat(64);
const DB_TEST_TIMEOUT_MS = 120_000;

const sourceId = createSafeId<"legislationSource">();
const eli = (tail: string) => `https://example.test/eli/cz/sb/${tail}`;

type VersionSeed = {
  id: SafeId<"legislationDocument">;
  eli: string;
  title: string;
  validFrom: string;
  validTo: string | null;
};

const version = (
  tail: string,
  title: string,
  validFrom: string,
  validTo: string | null,
): VersionSeed => ({
  id: createSafeId<"legislationDocument">(),
  eli: eli(tail),
  title,
  validFrom,
  validTo,
});

const CODE_TITLE = "89/2012 Sb., občanský zákoník";
const code2014 = version("2012/89", CODE_TITLE, "2014-01-01", "2020-01-01");
const code2020 = version("2012/89", CODE_TITLE, "2020-01-01", "2024-01-01");
const codeCurrent = version("2012/89", CODE_TITLE, "2024-01-01", null);
// An earlier act of the same name, repealed, in two versions.
const OLD_TITLE = "40/1964 Sb., občanský zákoník";
const old1964 = version("1964/40", OLD_TITLE, "1964-04-01", "1990-01-01");
const old1990 = version("1964/40", OLD_TITLE, "1990-01-01", "2014-01-01");
// An amending act that cites the code by its name.
const amendment = version(
  "2013/303",
  "303/2013 Sb., kterým se mění některé zákony v souvislosti s přijetím rekodifikace soukromého práva, a zákon č. 89/2012 Sb., občanský zákoník",
  "2014-01-01",
  null,
);
// An act whose title alone never says "zákon o …": only a citing title does.
const vat = version(
  "2004/235",
  "235/2004 Sb., o dani z přidané hodnoty",
  "2019-01-01",
  null,
);
const vatAmendment = version(
  "2020/1",
  "1/2020 Sb., kterým se mění zákon č. 235/2004 Sb., o dani z přidané hodnoty",
  "2020-02-01",
  null,
);
const VERSIONS = [
  code2014,
  code2020,
  codeCurrent,
  old1964,
  old1990,
  amendment,
  vat,
  vatAmendment,
];

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let legislationDb: LegislationReadDb;

const candidates = (...hits: [VersionSeed, number][]) =>
  hits.map(([seed, score]) => ({ id: String(seed.id), score }));

const rehydrate = async (
  query: string,
  hits: [VersionSeed, number][],
  cursorId?: string,
) =>
  await rehydrateLegislationCandidates({
    body: { query, jurisdiction: "CZE" },
    candidates: candidates(...hits),
    generation: GENERATION,
    legislationDb,
    cursorId,
  });

const ids = (result: { ranked: readonly { id: string }[] }) =>
  result.ranked.map((hit) => hit.id);

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    legislationDb = async <T>(
      fn: (tx: LegislationReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as LegislationReadTransaction;
        return await fn(tx);
      });

    await db
      .insert(legislationSources)
      .values([{ id: sourceId, adapterKey: "statutes-open", name: "Open" }]);
    await db.insert(legislationDocuments).values(
      VERSIONS.map((seed, index) => ({
        id: seed.id,
        sourceId,
        eli: seed.eli,
        title: seed.title,
        country: "CZE",
        language: "cs",
        versionValidFrom: seed.validFrom,
        versionValidTo: seed.validTo,
        contentHash: `hash-${String(index)}`,
      })),
    );
    await db.transaction(
      async (tx) =>
        await syncLegislationWorkNamesTx(
          asTestRaw(tx),
          VERSIONS.map((seed) => ({
            id: seed.id,
            country: "CZE",
            title: seed.title,
          })),
        ),
    );

    // Every version is held by the serving generation, so any may be a hit.
    await db.insert(corpusIndexGenerations).values({
      family: "legislation",
      generation: GENERATION,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS[GENERATION],
      ),
      status: "building",
    });
    const intents = VERSIONS.map((seed) => ({
      id: createSafeId<"corpusIndexProjectionIntent">(),
      entityId: seed.id,
    }));
    await db.insert(corpusIndexProjectionIntents).values(
      intents.map(({ id, entityId }) => ({
        id,
        family: "legislation" as const,
        generation: GENERATION,
        entityId,
        epoch: 1n,
        fingerprint: FINGERPRINT,
        indexId: INDEX_ID,
        status: "applied" as const,
        appendStartedAt: new Date(),
        appendCommittedAt: new Date(),
        expectedDocumentCount: 1,
        appliedAt: new Date(),
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
        appliedAt: new Date(),
      })),
    );
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

/** The relevance cursor a page ending at `last` hands the next request. */
const boundaryOf = (last: { score: number; id: string }): SearchCursor => ({
  score: last.score,
  id: last.id,
  sort: "relevance",
  windowStart: 0,
});

describe("one hit per act", () => {
  test("several versions of an act become one hit, shown as the current version", async () => {
    const result = await rehydrate("smlouva", [
      [code2014, 0.9],
      [code2020, 0.8],
      [old1964, 0.5],
      [codeCurrent, 0.3],
    ]);

    expect(ids(result)).toEqual([String(codeCurrent.id), String(old1964.id)]);
    expect(result.ranked[0]?.score).toBeCloseTo(0.9);
    // The shown version is readable from the page context like any hit.
    expect(result.context.byId.get(String(codeCurrent.id))?.title).toBe(
      CODE_TITLE,
    );
  });

  test("an act with no version in force is shown as its best-scoring version", async () => {
    const result = await rehydrate("smlouva", [
      [old1990, 0.6],
      [old1964, 0.4],
    ]);

    expect(ids(result)).toEqual([String(old1990.id)]);
  });

  test("the current version is the one the listing's definition selects", async () => {
    const documentRef = legislationVersionRef(legislationDocuments);
    const listed = await db
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .where(
        and(
          eq(legislationDocuments.eli, code2014.eli),
          inForceToday(documentRef),
          isCurrentVersionOfWork,
        ),
      );
    const result = await rehydrate("smlouva", [[code2020, 0.8]]);

    expect(listed.map((row) => String(row.id))).toEqual([
      String(codeCurrent.id),
    ]);
    expect(ids(result)).toEqual(listed.map((row) => String(row.id)));
  });

  test("an act shown on one page does not come back on the next", async () => {
    const scan: [VersionSeed, number][] = [
      [code2014, 0.9],
      [old1964, 0.5],
      [code2020, 0.4],
      [codeCurrent, 0.3],
    ];
    const pageOne = (await rehydrate("smlouva", scan)).ranked.slice(0, 1);
    const cursor = pageOne.at(-1);
    expect(cursor?.id).toBe(String(codeCurrent.id));
    if (cursor === undefined) {
      return;
    }

    // The next request replays the window without the cursor's own document.
    const replay = await rehydrate(
      "smlouva",
      scan.filter(([seed]) => String(seed.id) !== cursor.id),
      cursor.id,
    );
    const pageTwo = replay.ranked.filter((hit) =>
      isAfterSearchCursor(hit, boundaryOf(cursor)),
    );

    expect(ids({ ranked: pageTwo })).toEqual([String(old1964.id)]);
  });
});

describe("acts the query names come first", () => {
  test("a name in the act's own title, corroborated by a citation, pins the act in force", async () => {
    const result = await rehydrate("Občanský zákoník", [
      [old1964, 0.9],
      [amendment, 0.8],
      [code2014, 0.2],
    ]);

    // The repealed act of the same name is not pinned: a citation backs the
    // current code's name, and the current code applies today.
    expect(ids(result)).toEqual([
      String(codeCurrent.id),
      String(old1964.id),
      String(amendment.id),
    ]);
  });

  test("a name only a citing title gives the act pins it, even unscanned", async () => {
    const result = await rehydrate("zákon o dani z přidané hodnoty", [
      [vatAmendment, 0.9],
    ]);

    expect(ids(result)).toEqual([String(vat.id), String(vatAmendment.id)]);
  });

  test("a topical query that is no act's name pins nothing", async () => {
    const result = await rehydrate("daň z přidané hodnoty u služeb", [
      [vatAmendment, 0.9],
      [vat, 0.4],
    ]);

    expect(ids(result)).toEqual([String(vatAmendment.id), String(vat.id)]);
    expect(result.ranked[0]?.score).toBeCloseTo(0.9);
  });
});
