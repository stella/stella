import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
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
import type { CaseLawProvisionFilter } from "@/api/lib/case-law/provision-filter";
import { DEFAULT_SEARCH_SORT } from "@/api/lib/legal-search/corpus-search-order";
import { createFtsConfigCache } from "@/api/lib/legal-search/fts-config";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

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
    provision: Omit<CaseLawProvisionFilter, "unit">;
    expected: string[];
  }[] = [
    {
      provision: { work: "262/2006 Sb.", section: 316 },
      expected: [subsection.id],
    },
    {
      provision: { work: "262/2006 Sb.", section: 316, subsection: "2" },
      expected: [subsection.id],
    },
    {
      provision: { work: "262/2006 Sb.", section: 316, subsection: "1" },
      expected: [],
    },
    {
      provision: { work: "262/2006 Sb.", section: 52, letter: "g" },
      expected: [letter.id],
    },
    {
      provision: { work: "262/2006 Sb.", section: 52, letter: "h" },
      expected: [],
    },
    {
      provision: { work: "262/2006 Sb.", section: 31 },
      expected: [shorterSection.id],
    },
    {
      provision: { work: "89/2012 Sb.", section: 316 },
      expected: [otherWork.id],
    },
  ];
  for (const { provision, expected } of cases) {
    const plan = caseLawSearchPlan({
      body: {
        country: "CZE",
        query: WORD,
        provision: { unit: "section", ...provision },
      },
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
  }
  await client.close();
}, 60_000);
