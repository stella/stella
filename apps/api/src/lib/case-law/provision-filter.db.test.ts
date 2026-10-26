import { panic } from "better-result";
import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";
import { euProvisionAnchor } from "@stll/legal-atlas/eu-provision-citations";
import { provisionCitationProfileFor } from "@stll/legal-atlas/provision-citation-profiles";
import { renderProvisionAnchor } from "@stll/legal-atlas/provision-citation-resolve";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { caseLawSearchPlan } from "@/api/handlers/case-law/decisions/search";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  type CaseLawProvisionFilter,
  caseLawProvisionFilterOf,
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
      provision: {
        work: "262/2006 Sb.",
        anchor: "par_316-odst_2",
        subsection: "2",
      },
      expected: [subsection.id],
    },
    {
      provision: {
        work: "262/2006 Sb.",
        anchor: "par_316-odst_1",
        subsection: "1",
      },
      expected: [],
    },
    {
      provision: { work: "262/2006 Sb.", anchor: "par_52", letter: "g" },
      expected: [letter.id],
    },
    {
      provision: { work: "262/2006 Sb.", anchor: "par_52", letter: "h" },
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
    subsection: "2",
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

// timeout: Boot a fresh PGlite engine and complete schema before assertions.
test("a level the citation leaves out stays a wildcard while the read seeks the levels above it", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
  const decision = (caseNumber: string) => ({
    id: createSafeId<"caseLawDecision">(),
    sourceId,
    country: "CZE",
    language: "cs",
    court: "Nejvyšší soud",
    caseNumber,
    decisionDate: "2020-01-01",
  });
  const underSubsection = decision("8 Tdo 1/2020");
  const directLetter = decision("8 Tdo 2/2020");
  const otherLetter = decision("8 Tdo 3/2020");
  const unsuffixedSection = decision("8 Tdo 4/2020");
  const euUnderParagraph = decision("8 Tdo 5/2020");
  await db
    .insert(caseLawDecisions)
    .values([
      underSubsection,
      directLetter,
      otherLetter,
      unsuffixedSection,
      euUnderParagraph,
    ]);
  const criminalProcedure = (
    decisionId: SafeId<"caseLawDecision">,
    {
      sectionSuffix,
      subsection,
      letter,
    }: {
      sectionSuffix: string | null;
      subsection: string | null;
      letter: string;
    },
  ): typeof caseLawProvisionCitations.$inferInsert => {
    const anchor = [
      `par_265${sectionSuffix ?? ""}`,
      ...(subsection === null ? [] : [`odst_${subsection}`]),
      `pism_${letter}`,
    ].join("-");
    return {
      anchor,
      confidence: 0.9,
      decisionDate: "2020-01-01",
      decisionId,
      jurisdiction: "CZE",
      section: 265,
      sectionSuffix,
      subsection,
      letter,
      sentenceText: `sentence ${anchor}`,
      spanEnd: 20,
      spanStart: 10,
      unit: "section",
      workCollection: "Sb.",
      workIdentifier: "141/1961 Sb.",
      workNumber: 141,
      workYear: 1961,
    };
  };
  await db.insert(caseLawProvisionCitations).values([
    // § 265b odst. 1 písm. g): the letter under a subsection.
    criminalProcedure(underSubsection.id, {
      sectionSuffix: "b",
      subsection: "1",
      letter: "g",
    }),
    // § 265b písm. g): the letter directly under the section.
    criminalProcedure(directLetter.id, {
      sectionSuffix: "b",
      subsection: null,
      letter: "g",
    }),
    criminalProcedure(otherLetter.id, {
      sectionSuffix: "b",
      subsection: "1",
      letter: "h",
    }),
    // § 265 písm. g): another section that shares the number.
    criminalProcedure(unsuffixedSection.id, {
      sectionSuffix: null,
      subsection: null,
      letter: "g",
    }),
    {
      anchor: "art_6-par_1-pt_a",
      confidence: 0.9,
      decisionDate: "2020-01-01",
      decisionId: euUnderParagraph.id,
      jurisdiction: "EU",
      section: 6,
      subsection: "1",
      letter: "a",
      sentenceText: "sentence art_6-par_1-pt_a",
      spanEnd: 20,
      spanStart: 10,
      unit: "article",
      workCollection: "EUR-Lex",
      workIdentifier: "32016R0679",
      euWorkNumber: 679,
      euWorkYear: 2016,
      workEli: "http://data.europa.eu/eli/reg/2016/679/oj",
    },
  ]);
  const czech = provisionCitationProfileFor("CZE") ?? panic("CZE profile");
  const citing = async ({
    jurisdiction,
    work,
    ...levels
  }: {
    jurisdiction?: "EU";
    work: string;
    unit: "section" | "article";
    section: number;
    sectionSuffix?: string;
    subsection?: string;
    letter?: string;
    point?: string;
  }) => {
    const path = {
      sectionSuffix: null,
      subsection: null,
      letter: null,
      point: null,
      ...levels,
    };
    // The grammar's own anchor minter, as the agent tool passes it.
    const provision =
      jurisdiction === "EU"
        ? caseLawProvisionFilterOf({
            jurisdiction,
            work,
            path,
            anchorOf: (named) =>
              euProvisionAnchor({ ...named, openEnded: false, sentence: null }),
          })
        : caseLawProvisionFilterOf({
            work,
            path,
            anchorOf: (named) => renderProvisionAnchor(czech, named),
          });
    return await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the role transaction supplies the select surface the read uses.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      const scope = await readCaseLawProvisionScope(tx, {
        jurisdiction: "CZE",
        provision,
      });
      return scope.type === "decisions"
        ? scope.decisionIds.map(String).toSorted()
        : panic("expected the citing set");
    });
  };
  const criminalProcedureSection = {
    work: "141/1961 Sb.",
    unit: "section",
    section: 265,
  } as const;
  // § 265b písm. g): both stored shapes match.
  expect(
    await citing({
      ...criminalProcedureSection,
      sectionSuffix: "b",
      letter: "g",
    }),
  ).toEqual([underSubsection.id, directLetter.id].map(String).toSorted());
  // § 265b písm. h) does not match a link to písm. g).
  expect(
    await citing({
      ...criminalProcedureSection,
      sectionSuffix: "b",
      letter: "h",
    }),
  ).toEqual([String(otherLetter.id)]);
  // § 265b odst. 1 písm. g): named without a gap, so the seek is the letter.
  expect(
    await citing({
      ...criminalProcedureSection,
      sectionSuffix: "b",
      subsection: "1",
      letter: "g",
    }),
  ).toEqual([String(underSubsection.id)]);
  // § 265 písm. g) does not reach § 265b.
  expect(await citing({ ...criminalProcedureSection, letter: "g" })).toEqual([
    String(unsuffixedSection.id),
  ]);
  const gdpr = {
    jurisdiction: "EU",
    work: "32016R0679",
    unit: "article",
    section: 6,
  } as const;
  // Article 6(a) GDPR reaches the point stored under paragraph 1.
  expect(await citing({ ...gdpr, letter: "a" })).toEqual([
    String(euUnderParagraph.id),
  ]);
  expect(await citing({ ...gdpr, letter: "b" })).toEqual([]);
  // Article 6(01)(A) GDPR: the seek and the levels are read in the stored
  // spelling, so a padded or capitalised value still reaches the link.
  expect(await citing({ ...gdpr, subsection: "01", letter: "A" })).toEqual([
    String(euUnderParagraph.id),
  ]);
  // § 265B odst. 01 písm. G) likewise.
  expect(
    await citing({
      ...criminalProcedureSection,
      sectionSuffix: "B",
      subsection: "01",
      letter: "G",
    }),
  ).toEqual([String(underSubsection.id)]);
  await client.close();
}, 60_000);
