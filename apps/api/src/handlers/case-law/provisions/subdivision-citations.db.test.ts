import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSources,
} from "@/api/db/schema";
import { createStatuteCitationCountRepair } from "@/api/handlers/case-law/provisions/citation-count-repair";
import { readStatuteCitationCountsHandler } from "@/api/handlers/case-law/provisions/citation-counts";
import { listCitingDecisionsHandler } from "@/api/handlers/case-law/provisions/citing-decisions";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const WORK = "262/2006 Sb.";
const WORK_ELI = "/eli/cz/sb/2006/262";
const EU_WORK = "32016R0679";
const EU_ELI = "http://data.europa.eu/eli/reg/2016/679/oj";

const sourceId = createSafeId<"caseLawSource">();
/** Cites § 51 and § 51 odst. 1: one decision under § 51, two mentions. */
const sectionAndSubsectionId = createSafeId<"caseLawDecision">();
/** Cites only § 51 odst. 3 písm. a). */
const letterOnlyId = createSafeId<"caseLawDecision">();
/** Cites only § 51 odst. 1. */
const subsectionOnlyId = createSafeId<"caseLawDecision">();
/** Cites § 510 and § 5 odst. 1, neither of which sits under § 51. */
const neighbourId = createSafeId<"caseLawDecision">();

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let caseLawDb: CaseLawPublicReadDb;

type CitationOptions = {
  decisionId: SafeId<"caseLawDecision">;
  anchor: string;
  spanStart: number;
};

const czechCitation = ({
  decisionId,
  anchor,
  spanStart,
}: CitationOptions): typeof caseLawProvisionCitations.$inferInsert => ({
  anchor,
  confidence: 0.9,
  decisionDate: "2025-01-01",
  decisionId,
  jurisdiction: "CZE",
  section: 51,
  sentenceText: `sentence ${anchor} ${String(spanStart)}`,
  spanEnd: spanStart + 5,
  spanStart,
  unit: "section",
  workCollection: "Sb.",
  workEli: WORK_ELI,
  workIdentifier: WORK,
  workNumber: 262,
  workYear: 2006,
});

const euCitation = (
  options: CitationOptions,
): typeof caseLawProvisionCitations.$inferInsert => ({
  ...czechCitation(options),
  jurisdiction: "EU",
  unit: "article",
  section: 6,
  workCollection: "EUR-Lex",
  workEli: EU_ELI,
  workIdentifier: EU_WORK,
  euWorkNumber: 679,
  euWorkYear: 2016,
});

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  const readDb = async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await withPublicLawReaderRole(
      db,
      async (tx) =>
        // SAFETY: the role transaction has the same Drizzle read surface as
        // the public-law handle; writes remain on the owner database above.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite test transaction stands in for the public read handle
        await fn(tx as unknown as CaseLawPublicReadTransaction),
    );
  // SAFETY: brand-only wrapper; the reads never inspect the marker.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  caseLawDb = readDb as unknown as CaseLawPublicReadDb;

  await db
    .insert(caseLawSources)
    .values(caseLawSourceRow({ adapterKey: "open", id: sourceId }));
  await db.insert(caseLawDecisions).values(
    [sectionAndSubsectionId, letterOnlyId, subsectionOnlyId, neighbourId].map(
      (id, index) => ({
        caseNumber: `${String(index + 1)} C 1/2025`,
        country: "CZE",
        court: "Court",
        decisionDate: "2025-01-01",
        id,
        language: "cs",
        sourceId,
      }),
    ),
  );
  await db.insert(caseLawProvisionCitations).values([
    czechCitation({
      decisionId: sectionAndSubsectionId,
      anchor: "par_51",
      spanStart: 10,
    }),
    czechCitation({
      decisionId: sectionAndSubsectionId,
      anchor: "par_51-odst_1",
      spanStart: 20,
    }),
    czechCitation({
      decisionId: letterOnlyId,
      anchor: "par_51-odst_3-pism_a",
      spanStart: 10,
    }),
    czechCitation({
      decisionId: subsectionOnlyId,
      anchor: "par_51-odst_1",
      spanStart: 10,
    }),
    czechCitation({
      decisionId: neighbourId,
      anchor: "par_510",
      spanStart: 10,
    }),
    czechCitation({
      decisionId: neighbourId,
      anchor: "par_5-odst_1",
      spanStart: 20,
    }),
    euCitation({
      decisionId: sectionAndSubsectionId,
      anchor: "art_6-par_1-pt_a",
      spanStart: 30,
    }),
    euCitation({
      decisionId: sectionAndSubsectionId,
      anchor: "art_6-par_1-pt_f",
      spanStart: 40,
    }),
    euCitation({ decisionId: letterOnlyId, anchor: "art_6", spanStart: 30 }),
  ]);

  const repair = createStatuteCitationCountRepair(db);
  let batch = await repair();
  while (batch.status === "advanced") {
    batch = await repair();
  }
}, 120_000);

afterAll(async () => await client.close());

type CitingQuery = {
  anchor: string;
  jurisdiction?: string;
  sort?: "citations";
} & ({ eli: string } | { work: string });

const citingMentions = async ({
  jurisdiction = "CZE",
  ...query
}: CitingQuery) => {
  const page = await listCitingDecisionsHandler(
    { jurisdiction, limit: 10, ...query },
    { caseLawDb, courtRegistry: new Map() },
  );
  if (!("items" in page)) {
    return panic("Expected a citing decisions page");
  }
  return page.items.map(({ decisionId, mentionCount }) => ({
    decisionId,
    mentionCount,
  }));
};

/** The count rows by anchor; their order follows the database collation. */
const countsByAnchor = async (jurisdiction: string, eli: string) => {
  const counts = await readStatuteCitationCountsHandler(
    { jurisdiction, eli },
    caseLawDb,
  );
  if (!("provisions" in counts)) {
    return panic("Expected ready citation counts");
  }
  return new Map(
    counts.provisions.map(({ anchor, decisionCount }) => [
      anchor,
      decisionCount,
    ]),
  );
};

const byDecision = (
  rows: readonly { decisionId: string; mentionCount: number }[],
) => new Map(rows.map((row) => [row.decisionId, row.mentionCount]));

test("a section lists the decisions citing only its subdivisions, once each", async () => {
  const expected = new Map<string, number>([
    [sectionAndSubsectionId, 2],
    [letterOnlyId, 1],
    [subsectionOnlyId, 1],
  ]);
  for (const key of [{ eli: WORK_ELI }, { work: WORK }]) {
    expect(
      byDecision(await citingMentions({ anchor: "par_51", ...key })),
    ).toEqual(expected);
  }
  expect(
    (
      await citingMentions({
        anchor: "par_51",
        eli: WORK_ELI,
        sort: "citations",
      })
    ).at(0),
  ).toEqual({ decisionId: sectionAndSubsectionId, mentionCount: 2 });
});

test("a subdivision lists its own subtree and not its siblings or parent", async () => {
  expect(
    byDecision(
      await citingMentions({ anchor: "par_51-odst_1", eli: WORK_ELI }),
    ),
  ).toEqual(
    new Map([
      [sectionAndSubsectionId, 1],
      [subsectionOnlyId, 1],
    ]),
  );
  expect(
    byDecision(
      await citingMentions({ anchor: "par_51-odst_3", eli: WORK_ELI }),
    ),
  ).toEqual(new Map([[letterOnlyId, 1]]));
  expect(
    byDecision(await citingMentions({ anchor: "par_5", eli: WORK_ELI })),
  ).toEqual(new Map([[neighbourId, 1]]));
});

test("section counts include decisions citing only a subdivision, once each", async () => {
  expect(await countsByAnchor("CZE", WORK_ELI)).toEqual(
    new Map([
      ["par_5", 1],
      ["par_5-odst_1", 1],
      ["par_51", 3],
      ["par_51-odst_1", 2],
      ["par_51-odst_3", 1],
      ["par_51-odst_3-pism_a", 1],
      ["par_510", 1],
    ]),
  );
});

test("EU article lists and counts include citations of its paragraphs and points", async () => {
  expect(
    byDecision(
      await citingMentions({
        anchor: "art_6",
        jurisdiction: "EU",
        eli: EU_ELI,
      }),
    ),
  ).toEqual(
    new Map([
      [sectionAndSubsectionId, 2],
      [letterOnlyId, 1],
    ]),
  );
  expect(await countsByAnchor("EU", EU_ELI)).toEqual(
    new Map([
      ["art_6", 2],
      ["art_6-par_1", 1],
      ["art_6-par_1-pt_a", 1],
      ["art_6-par_1-pt_f", 1],
    ]),
  );
});
