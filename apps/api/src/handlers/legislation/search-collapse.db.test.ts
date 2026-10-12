import type { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { STATUTE_ALIASES } from "@stll/api-contract/statute-aliases";
import { assertProperty } from "@stll/property-testing";

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
import { PUBLIC_LEGISLATION_SEARCH_RESPONSE_MAX_BYTES } from "@/api/handlers/legislation/search-response";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { isAfterSearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import { corpusSearchGroupToken } from "@/api/lib/legal-search/corpus-search-cursor";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { isCurrentVersionOfWork } from "@/api/lib/legal-search/legislation-current-version";
import {
  inForceToday,
  legislationVersionRef,
} from "@/api/lib/legal-search/legislation-validity-window";
import {
  legislationWorkRefKey,
  readNamedLegislationWorks,
  syncLegislationWorkNamesTx,
} from "@/api/lib/legal-search/legislation-work-names";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { TS_HEADLINE_CONFIG } from "@/api/lib/search/highlight";
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

const byteCapVersion = version(
  "2024/99001",
  "Byte cap fixture",
  "2024-01-01",
  null,
);

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

// Alias targets are derived from their owner; added documents have no search
// projection, so these identity lookups cannot change the paging fixtures.
const aliasTargetSeeds = [
  ...new Map(
    Object.values(STATUTE_ALIASES.cze).map(
      (target) =>
        [
          `${target.collection}/${target.year}/${target.number}`,
          target,
        ] as const,
    ),
  ).values(),
]
  .filter(
    (target) =>
      !VERSIONS.some(
        (seed) => seed.eli === eli(`${target.year}/${target.number}`),
      ),
  )
  .map((target) =>
    version(
      `${target.year}/${target.number}`,
      target.label,
      "2024-01-01",
      null,
    ),
  );
const domesticSameNumber = version(
  "2008/57",
  "57/2008 Sb.",
  "2008-01-01",
  null,
);
const internationalSameNumber = {
  ...version("2008/57", "57/2008 Sb. m. s.", "2008-01-01", null),
  eli: "https://example.test/eli/cz/sm/2008/57",
};
const IDENTITY_LOOKUP_VERSIONS = [
  ...aliasTargetSeeds,
  domesticSameNumber,
  internationalSameNumber,
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
    await db.insert(legislationDocuments).values(
      IDENTITY_LOOKUP_VERSIONS.map((seed, index) => ({
        id: seed.id,
        sourceId,
        eli: seed.eli,
        title: seed.title,
        country: "CZE",
        language: "cs",
        versionValidFrom: seed.validFrom,
        versionValidTo: seed.validTo,
        contentHash: `identity-lookup-${String(index)}`,
      })),
    );
    await db.insert(legislationDocuments).values({
      id: byteCapVersion.id,
      sourceId,
      eli: byteCapVersion.eli,
      title: byteCapVersion.title,
      country: "CZE",
      language: "cs",
      versionValidFrom: byteCapVersion.validFrom,
      contentHash: "byte-cap-fixture",
    });
    await db.insert(legislationSearchDocuments).values({
      documentId: byteCapVersion.id,
      title: byteCapVersion.title,
      searchableText: "bytecapfixture",
      language: "cs",
      regconfig: "simple",
      tsv: sql`to_tsvector('simple', 'bytecapfixture')`,
    });
    // The excerpt configuration the Postgres path highlights with.
    await db.execute(
      sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
    );
    // The Postgres path's index: every version but the code's current one
    // matches "smlouva", so that act is found only by its older versions.
    await db.insert(legislationSearchDocuments).values(
      VERSIONS.filter((seed) => seed.id !== codeCurrent.id).map((seed) => ({
        documentId: seed.id,
        title: seed.title,
        searchableText: `${seed.title} smlouva`,
        language: "cs",
        regconfig: "simple",
        tsv: sql`to_tsvector('simple', ${`${seed.title} smlouva`})`,
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
    const intents = [...VERSIONS, byteCapVersion].map((seed) => ({
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
        expectedDocumentCount: entityId === vat.id ? 3 : 1,
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
    const cursor = pageOne.at(-1) ?? panic("page one is empty");
    expect(cursor.id).toBe(String(codeCurrent.id));

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
  test.each([
    "Výklad smlouvy podle zákona č. 89/2012 Sb. při náhradě škody",
    "Výklad smlouvy podle OZ při náhradě škody",
    "Vyklad smlouvy podle NOZ pri nahrade skody",
    "Výklad smlouvy podle občanského zákoníku a § 2051 zákona č. 89/2012 Sb.",
  ])(
    "a reference inside %s pins the act even when only its amendment was scanned",
    async (query) => {
      const scan: [VersionSeed, number][] = [[amendment, 0.9]];
      expect(scan.some(([seed]) => seed.eli === codeCurrent.eli)).toBe(false);

      const result = await rehydrate(query, scan);

      expect(ids(result)).toEqual([
        String(codeCurrent.id),
        String(amendment.id),
      ]);
    },
  );

  test.each(Object.entries(STATUTE_ALIASES.cze))(
    "the whole-query shared alias %s resolves to its declared act",
    async (alias, target) => {
      const named = await legislationDb(
        async (tx) =>
          await readNamedLegislationWorks(tx, {
            query: alias,
            country: "CZE",
          }),
      );

      expect(named.map((work) => work.eli)).toEqual([
        `https://example.test/eli/cz/${target.collection}/${target.year}/${target.number}`,
      ]);
      expect(named.every((work) => work.fromCitation)).toBe(true);
    },
  );

  test.each([
    "Použití oz při výkladu smlouvy",
    "Použití noz při výkladu smlouvy",
    "Použití sr při vyřizování žádosti",
    "Občan předložil občanský průkaz",
    "Společnost předložila zakladatelskou listinu",
    "Použití obc. zak. při výkladu smlouvy",
    "Občanský průkaz občana obsahuje jeho jméno",
    "Při zakladatelské listině společnosti se ověřuje podpis",
  ])("ordinary prose %s never pins an alias target", async (query) => {
    const named = await legislationDb(
      async (tx) =>
        await readNamedLegislationWorks(tx, { query, country: "CZE" }),
    );
    expect(named).toEqual([]);

    const result = await rehydrate(query, [[amendment, 0.9]]);
    expect(ids(result)).toEqual([String(amendment.id)]);
  });

  test.each([
    ["Výklad zákona č. 57/2008 Sb.", domesticSameNumber],
    ["Výklad smlouvy č. 57/2008 Sb. m. s.", internationalSameNumber],
  ] as const)(
    "the collection in %s selects only that act",
    async (query, expected) => {
      expect(domesticSameNumber.eli).not.toBe(internationalSameNumber.eli);
      const named = await legislationDb(
        async (tx) =>
          await readNamedLegislationWorks(tx, { query, country: "CZE" }),
      );

      expect(named.map((work) => work.eli)).toEqual([expected.eli]);
    },
  );

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

describe("acts an earlier scan window showed", () => {
  test("only recurring Works consume the carried budget, including the cursor Work", async () => {
    const result = await rehydrate("smlouva", [
      [amendment, 0.9],
      [vat, 0.8],
      [code2014, 0.7],
    ]);
    const tokenOf = (seed: VersionSeed) =>
      corpusSearchGroupToken(
        legislationWorkRefKey({ sourceId, eli: seed.eli, language: "cs" }),
      );
    expect(new Set(result.groups)).toEqual(
      new Set([tokenOf(vat), tokenOf(code2014)]),
    );
    expect(ids(result)).toContain(String(amendment.id));

    const continuation = await rehydrate(
      "smlouva",
      [[vat, 0.8]],
      String(amendment.id),
    );
    expect(continuation.groups).toContain(tokenOf(amendment));
  });

  test("stay off the page when the cursor carries them", async () => {
    const codeToken = corpusSearchGroupToken(
      legislationWorkRefKey({ sourceId, eli: code2014.eli, language: "cs" }),
    );
    const scan = candidates([code2014, 0.9], [old1964, 0.5]);

    const shown = await rehydrateLegislationCandidates({
      body: { query: "smlouva", jurisdiction: "CZE" },
      candidates: scan,
      generation: GENERATION,
      legislationDb,
    });
    const carried = await rehydrateLegislationCandidates({
      body: { query: "smlouva", jurisdiction: "CZE" },
      candidates: scan,
      generation: GENERATION,
      legislationDb,
      excludedWorkTokens: [codeToken],
    });

    expect(shown.groups).toContain(codeToken);
    expect(ids(carried)).toEqual([String(old1964.id)]);
  });
});

describe("the Postgres search path", () => {
  const searchDependencies = {
    provider: "pg-fts",
    loadSearchConfigs: async () =>
      await Promise.resolve([
        {
          regconfig: "simple",
          useUnaccent: false,
          includeDefault: true,
          languages: [],
        },
      ]),
  } satisfies NonNullable<Parameters<typeof searchLegislationHandler>[3]>;

  test.each([
    ["OZ", STATUTE_ALIASES.cze.oz],
    ["ZP", STATUTE_ALIASES.cze.zp],
    ["TrZ", STATUTE_ALIASES.cze.trz],
    ["OSŘ", STATUTE_ALIASES.cze.osr],
  ] as const)(
    "the embedded abbreviation %s reaches the public search result as a strict pin",
    async (abbreviation, target) => {
      const response = await searchLegislationHandler(
        {
          query: `Použití ${abbreviation} při výkladu`,
          jurisdiction: "CZE",
          limit: 10,
        },
        legislationDb,
        "unobserved",
        searchDependencies,
      );
      if (!("items" in response)) {
        panic("the search refused an embedded act abbreviation");
      }
      const firstHit = response.items.at(0);
      expect(firstHit?.eli).toBe(
        `https://example.test/eli/cz/${target.collection}/${target.year}/${target.number}`,
      );
      expect(firstHit?.match).toEqual({ type: "strict" });
    },
  );

  /** Every page of a query, `limit` hits at a time. */
  const allPages = async (query: string, limit: number) => {
    const pages: { documentId: string; headline: string | null }[][] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      // db-await-in-loop: one keyset page per iteration, as a reader pages
      const response = await searchLegislationHandler(
        {
          query,
          jurisdiction: "CZE",
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        },
        legislationDb,
        "unobserved",
        searchDependencies,
      );
      if (!("items" in response)) {
        return panic("the search refused a page it issued the cursor for");
      }
      pages.push(response.items);
      if (response.nextCursor === null) {
        return pages;
      }
      cursor = response.nextCursor;
    }
    return panic("the search never reached its last page");
  };

  test("an issued Postgres cursor is bound to its query and filters", async () => {
    const body = { query: "smlouva", jurisdiction: "CZE", limit: 1 };
    const page = await searchLegislationHandler(
      body,
      legislationDb,
      "unobserved",
      searchDependencies,
    );
    if (!("items" in page) || page.nextCursor === null) {
      panic("the fixture did not issue a Postgres cursor");
    }
    const control = await searchLegislationHandler(
      { ...body, cursor: page.nextCursor },
      legislationDb,
      "unobserved",
      searchDependencies,
    );
    if (!("items" in control)) {
      panic("the search refused its own cursor");
    }
    expect(control.items.length).toBeGreaterThan(0);
    for (const change of [{ query: "náhrada" }, { language: "cs" }]) {
      // db-await-in-loop: each replay changes an independent request field
      const response = await searchLegislationHandler(
        { ...body, ...change, cursor: page.nextCursor },
        legislationDb,
        "unobserved",
        searchDependencies,
      );
      expect(response).toMatchObject({
        code: 400,
        response: { message: "Invalid cursor" },
      });
    }
  });

  test("shows each act once, as its current version, across pages", async () => {
    const pages = await allPages("smlouva", 2);
    const shown = pages.flat().map((hit) => hit.documentId);

    // Five acts match, each on exactly one page, and the code is shown as
    // the version in force although only its older versions matched.
    expect(shown.toSorted()).toEqual(
      [codeCurrent, old1990, amendment, vat, vatAmendment]
        .map((seed) => String(seed.id))
        .toSorted(),
    );
    expect(pages.length).toBe(3);
    // Another version's excerpt is not shown under the current one.
    expect(
      pages.flat().find((hit) => hit.documentId === String(codeCurrent.id))
        ?.headline,
    ).toBeNull();
  });

  test("places the act a query names first and never shows it again", async () => {
    const pages = await allPages("zákon o dani z přidané hodnoty", 1);
    const shown = pages.flat().map((hit) => hit.documentId);

    expect(shown[0]).toBe(String(vat.id));
    expect(shown.filter((id) => id === String(vat.id))).toHaveLength(1);
    expect(shown).toContain(String(vatAmendment.id));
    expect(new Set(shown).size).toBe(shown.length);
  });

  test("a topical query pins nothing", async () => {
    const [firstPage] = await allPages("smlouva přidané hodnoty", 10);

    expect((firstPage ?? []).map((hit) => hit.documentId).toSorted()).toEqual(
      [String(vat.id), String(vatAmendment.id)].toSorted(),
    );
  });
});

const oversizedUnicode = fc
  .array(fc.constantFrom("a", "é", "漢", "😀", "e\u0301", '"', "\\"), {
    minLength: 1,
    maxLength: 8,
  })
  .map((atoms) => atoms.join("").repeat(6000));

const oversizedDisplayFieldProperty = (provider: "pg-fts" | "corpus-index") =>
  fc.asyncProperty(oversizedUnicode, async (text) => {
    expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(
      LIMITS.legislationSearchTextBytes.title,
    );
    expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(
      LIMITS.legislationSearchTextBytes.headline,
    );
    const fulltext = `bytecapfixture ${"漢".repeat(250)} `.repeat(30);
    if (provider === "pg-fts") {
      const raw = await db.execute(sql`SELECT ts_headline(
          'public.stella_unaccent'::regconfig,
          ${fulltext},
          plainto_tsquery('simple', 'bytecapfixture'),
          ${TS_HEADLINE_CONFIG}
        ) AS headline`);
      const headline = raw.rows.at(0)?.["headline"];
      if (typeof headline !== "string") {
        panic("byte-cap fixture did not yield a Postgres headline");
      }
      expect(Buffer.byteLength(headline, "utf-8")).toBeGreaterThan(
        LIMITS.legislationSearchTextBytes.headline,
      );
    }
    await db
      .update(legislationDocuments)
      .set({ title: text, fulltext })
      .where(eq(legislationDocuments.id, byteCapVersion.id));
    const corpusClient = getCorpusIndexClient("q09");
    const engineSearch =
      provider === "corpus-index"
        ? spyOn(corpusClient, "search").mockImplementation(async () =>
            Result.ok({
              numHits: 1,
              hits: [{ document_id: String(byteCapVersion.id) }],
              snippets: [{ text: [`<b>${text}</b>`] }],
            }),
          )
        : null;
    try {
      const response = await searchLegislationHandler(
        { query: "bytecapfixture", jurisdiction: "CZE", limit: 20 },
        legislationDb,
        "unobserved",
        {
          provider,
          loadSearchConfigs: async () => [
            {
              regconfig: "simple",
              useUnaccent: false,
              includeDefault: true,
              languages: [],
            },
          ],
          readServingGeneration: async () =>
            Result.ok({
              family: "legislation",
              generation: GENERATION,
              cluster: "q09",
            }),
        },
      );
      if (!("items" in response)) {
        panic("byte-cap fixture search was refused");
      }
      expect(response.items).toHaveLength(1);
      const hit = response.items.at(0);
      if (hit === undefined) {
        panic("byte-cap fixture did not yield a search hit");
      }
      if (hit.headline === null) {
        panic("byte-cap fixture did not yield a highlighted search hit");
      }
      expect(hit.documentId).toBe(String(byteCapVersion.id));
      expect(hit.title).not.toBe(text);
      expect(Buffer.byteLength(hit.title, "utf-8")).toBeLessThanOrEqual(
        LIMITS.legislationSearchTextBytes.title,
      );
      expect(Buffer.byteLength(hit.headline, "utf-8")).toBeLessThanOrEqual(
        LIMITS.legislationSearchTextBytes.headline,
      );
      expect(hit.title.isWellFormed()).toBe(true);
      expect(hit.headline.isWellFormed()).toBe(true);
      let depth = 0;
      for (const tag of hit.headline.matchAll(/<\/?mark>/gu)) {
        depth += tag[0] === "<mark>" ? 1 : -1;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
      expect(depth).toBe(0);
      expect(
        Buffer.byteLength(JSON.stringify(response), "utf-8"),
      ).toBeLessThanOrEqual(PUBLIC_LEGISLATION_SEARCH_RESPONSE_MAX_BYTES);
    } finally {
      engineSearch?.mockRestore();
    }
  });

test("legislation pg-fts search bounds oversized Unicode display fields", async () => {
  await assertProperty(
    "legislation pg-fts search bounds oversized Unicode display fields",
    oversizedDisplayFieldProperty("pg-fts"),
    { numRuns: 12 },
  );
});

test("legislation corpus-index search bounds oversized Unicode display fields", async () => {
  await assertProperty(
    "legislation corpus-index search bounds oversized Unicode display fields",
    oversizedDisplayFieldProperty("corpus-index"),
    { numRuns: 12 },
  );
});
