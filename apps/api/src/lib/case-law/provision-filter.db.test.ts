import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { caseLawSearchPlan } from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  type CaseLawProvisionFilter,
  readCaseLawProvisionScope,
  readProvisionWorkLinked,
} from "@/api/lib/case-law/provision-filter";
import { DEFAULT_SEARCH_SORT } from "@/api/lib/legal-search/corpus-search-order";
import { createFtsConfigCache } from "@/api/lib/legal-search/fts-config";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const WORD = "zqxprovisionfilter";

test("the Postgres search narrows to decisions citing the provision, level by level", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  await db.execute(
    sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
  );
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
  const decision = (caseNumber: string, country = "CZE") => ({
    id: createSafeId<"caseLawDecision">(),
    sourceId,
    country,
    language: country === "CZE" ? "cs" : "sk",
    court: "Nejvyšší soud",
    caseNumber,
    decisionDate: "2020-01-01",
  });
  const subsection = decision("21 Cdo 1/2020");
  const letter = decision("21 Cdo 2/2020");
  const shorterSection = decision("21 Cdo 3/2020");
  const otherWork = decision("21 Cdo 4/2020");
  const uncited = decision("21 Cdo 5/2020");
  const decisions = [subsection, letter, shorterSection, otherWork, uncited];
  await db.insert(caseLawDecisions).values(decisions);
  await db.insert(caseLawSearchDocuments).values(
    decisions.map(({ id, language }) => ({
      decisionId: id,
      searchableText: WORD,
      language,
      regconfig: "simple",
      tsv: sql`to_tsvector('simple', ${WORD})`,
    })),
  );
  const link = (
    decisionId: (typeof decisions)[number]["id"],
    {
      work = "262/2006 Sb.",
      section,
      subsection: sub = null,
      letter: pism = null,
    }: {
      work?: string;
      section: number;
      subsection?: string | null;
      letter?: string | null;
    },
  ): typeof caseLawProvisionCitations.$inferInsert => {
    const [number = "0", year = "0"] = work.replace(" Sb.", "").split("/");
    const anchor = [
      `par_${String(section)}`,
      ...(sub === null ? [] : [`odst_${sub}`]),
      ...(pism === null ? [] : [`pism_${pism}`]),
    ].join("-");
    return {
      anchor,
      confidence: 0.9,
      decisionDate: "2020-01-01",
      decisionId,
      jurisdiction: "CZE",
      section,
      subsection: sub,
      letter: pism,
      sentenceText: `sentence ${anchor}`,
      spanEnd: 20,
      spanStart: 10,
      unit: "section",
      workCollection: "Sb.",
      workIdentifier: work,
      workNumber: Number(number),
      workYear: Number(year),
    };
  };
  await db.insert(caseLawProvisionCitations).values([
    link(subsection.id, { section: 316, subsection: "2" }),
    link(letter.id, { section: 52, letter: "g" }),
    link(shorterSection.id, { section: 31 }),
    link(otherWork.id, {
      work: "89/2012 Sb.",
      section: 316,
      subsection: "2",
    }),
  ]);
  const configs = await createFtsConfigCache(async () => [
    { language: "cs", regconfig: "simple", useUnaccent: false },
  ]).loadFtsSearchConfigs();
  const courtWeights = courtWeightMapFromSeed();

  const cases: {
    provision: CaseLawProvisionFilter;
    expected: string[];
  }[] = [
    {
      provision: { work: "262/2006 Sb.", anchor: "par_316" },
      expected: [subsection.id],
    },
    {
      provision: { work: "262/2006 Sb.", anchor: "par_316-odst_2" },
      expected: [subsection.id],
    },
    {
      provision: { work: "262/2006 Sb.", anchor: "par_316-odst_1" },
      expected: [],
    },
    {
      provision: { work: "262/2006 Sb.", anchor: "par_52-pism_g" },
      expected: [letter.id],
    },
    {
      provision: { work: "262/2006 Sb.", anchor: "par_52-pism_h" },
      expected: [],
    },
    {
      provision: { work: "262/2006 Sb.", anchor: "par_31" },
      expected: [shorterSection.id],
    },
    {
      provision: { work: "89/2012 Sb.", anchor: "par_316" },
      expected: [otherWork.id],
    },
  ];
  for (const { provision, expected } of cases) {
    const plan = caseLawSearchPlan({
      body: { country: "CZE", query: WORD, provision },
      configs,
      courtWeights,
      excerpt: DEFAULT_SEARCH_EXCERPT,
      limit: 10,
      parsedCursor: null,
      queryUsed: WORD,
      sort: DEFAULT_SEARCH_SORT,
    });
    const result = await db.execute(plan.hits);
    expect(
      result.rows.map((row) => String(row["decision_id"])).toSorted(),
    ).toEqual(expected.map(String).toSorted());
    // Facets count the same narrowed set the page lists, never the whole
    // topic: every decision here sits at one court.
    const courts = await db.execute(plan.facets.court);
    expect(
      courts.rows.reduce((sum, row) => sum + Number(row["count"]), 0),
    ).toBe(expected.length);
  }
  await client.close();
}, 60_000);

test("the provision scope includes only published redistributable decisions in its set and exact size", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
  const decisions = ["1", "2", "3"].map((index) => ({
    id: createSafeId<"caseLawDecision">(),
    sourceId,
    country: "CZE",
    language: "cs",
    court: "Nejvyšší soud",
    caseNumber: `21 Cdo ${index}/2020`,
    decisionDate: "2020-01-01",
  }));
  await db.insert(caseLawDecisions).values(decisions);
  const restrictedSourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values(
    caseLawSourceRow({
      id: restrictedSourceId,
      adapterKey: "restricted-provision",
      descriptor: {
        allowsDerivedAi: false,
        allowsRedistribution: false,
        attribution: null,
        license: "restricted",
      },
    }),
  );
  // Two links in one decision count it once; the third decision cites
  // another subsection.
  const link = (
    decisionId: (typeof decisions)[number]["id"],
    subsection: string,
    spanStart: number,
  ): typeof caseLawProvisionCitations.$inferInsert => ({
    anchor: `par_316-odst_${subsection}`,
    confidence: 0.9,
    decisionDate: "2020-01-01",
    decisionId,
    jurisdiction: "CZE",
    section: 316,
    subsection,
    sentenceText: "sentence",
    spanEnd: spanStart + 10,
    spanStart,
    unit: "section",
    workCollection: "Sb.",
    workIdentifier: "262/2006 Sb.",
    workNumber: 262,
    workYear: 2006,
  });
  const [first, second, third] = decisions;
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("expected three decisions");
  }
  const excludedDecisions = [
    {
      ...first,
      id: createSafeId<"caseLawDecision">(),
      caseNumber: "listing-only",
      metadata: {
        _stellaPartialObservation: {
          caseNumberIsPlaceholder: false,
          isListingOnly: true,
        },
      },
    },
    {
      ...first,
      id: createSafeId<"caseLawDecision">(),
      caseNumber: "redacted",
      redactedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      ...first,
      id: createSafeId<"caseLawDecision">(),
      caseNumber: "restricted-source",
      sourceId: restrictedSourceId,
    },
  ];
  await db.insert(caseLawDecisions).values(excludedDecisions);
  await db
    .insert(caseLawProvisionCitations)
    .values([
      link(first.id, "2", 10),
      link(first.id, "2", 40),
      link(second.id, "2", 10),
      link(third.id, "1", 10),
      ...excludedDecisions.map(({ id }) => link(id, "2", 10)),
    ]);
  const [storedScope] = await db
    .select({
      count: sql<number>`count(DISTINCT ${caseLawProvisionCitations.decisionId})::int`,
    })
    .from(caseLawProvisionCitations);
  expect(storedScope?.count).toBe(6);
  const read = async (provision: CaseLawProvisionFilter, idSetMax?: number) =>
    await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the role transaction supplies the select surface the read uses.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      return await readCaseLawProvisionScope(tx, {
        jurisdiction: "CZE",
        provision,
        ...(idSetMax === undefined ? {} : { idSetMax }),
      });
    });
  const subsection: CaseLawProvisionFilter = {
    work: "262/2006 Sb.",
    anchor: "par_316-odst_2",
  };
  const scope = await read(subsection);
  expect(scope.type).toBe("decisions");
  expect(
    scope.type === "decisions" ? scope.decisionIds.map(String).toSorted() : [],
  ).toEqual([first.id, second.id].map(String).toSorted());
  // Past the bound the set is not handed over, but its size is exact.
  expect(await read({ work: "262/2006 Sb.", anchor: "par_316" }, 2)).toEqual({
    type: "broad",
    citingDecisions: 3,
  });
  // Exactly at the bound the set still fits.
  expect((await read(subsection, 2)).type).toBe("decisions");
  expect(await read({ work: "262/2006 Sb.", anchor: "par_317" })).toEqual({
    type: "decisions",
    decisionIds: [],
  });
  await db
    .update(caseLawDecisions)
    .set({ country: "SVK" })
    .where(eq(caseLawDecisions.id, third.id));
  await db.insert(caseLawProvisionCitations).values(
    [first.id, third.id].map((decisionId) => ({
      ...link(decisionId, "1", 80),
      jurisdiction: "EU",
      workIdentifier: "32016R0679",
      euWorkNumber: 679,
      euWorkYear: 2016,
      workCollection: "EUR-Lex",
      workEli: "http://data.europa.eu/eli/reg/2016/679/oj",
      unit: "article" as const,
      section: 6,
      anchor: "art_6-par_1",
    })),
  );
  const euScope = await read({
    jurisdiction: "EU",
    work: "32016R0679",
    anchor: "art_6",
  });
  expect(euScope).toEqual({ type: "decisions", decisionIds: [first.id] });
  // The same work token in a national filter cannot reach EU links.
  expect(await read({ work: "32016R0679", anchor: "art_6" })).toEqual({
    type: "decisions",
    decisionIds: [],
  });

  // An act no link names is told apart from a provision nobody cites, so a
  // caller never reports the missing extraction as "cited by 0".
  const linked = async (provision: CaseLawProvisionFilter) =>
    await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the role transaction supplies the select surface the read uses.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      return await readProvisionWorkLinked(tx, {
        jurisdiction: "CZE",
        provision,
      });
    });
  expect(await linked({ work: "262/2006 Sb.", anchor: "par_317" })).toBe(true);
  expect(await linked({ work: "89/2012 Sb.", anchor: "par_2910" })).toBe(false);
  expect(
    await linked({ jurisdiction: "EU", work: "32016R0679", anchor: "art_6" }),
  ).toBe(true);
  expect(
    await linked({ jurisdiction: "EU", work: "12016E/TXT", anchor: "art_267" }),
  ).toBe(false);
  // A national filter never counts the EU links of the same token.
  expect(await linked({ work: "32016R0679", anchor: "art_6" })).toBe(false);
  await client.close();
}, 60_000);
