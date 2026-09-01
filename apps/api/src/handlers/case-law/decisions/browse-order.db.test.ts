import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { readLatestDecisionsByCourt } from "@/api/handlers/case-law/decisions/latest";
import { listDecisionsHandler } from "@/api/handlers/case-law/decisions/list";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * The browse walk is newest decision first, one row per multilingual
 * decision, with a keyset cursor that neither repeats nor skips a row across
 * pages. The second line of a row is derived from what the publisher stored.
 */

const DB_TEST_TIMEOUT_MS = 120_000;

const sourceId = createSafeId<"caseLawSource">();

type Seed = {
  caseNumber: string;
  court: string;
  createdAt: Date;
  decisionDate: string | null;
  language: string;
  languageGroupKey: string | null;
  metadata?: Record<string, unknown>;
};

const day = (offset: number) => new Date(2026, 0, 1, 12, 0, offset);

/** Ten dated decisions, one undated, and a CJEU judgment in three languages. */
const seeds: Seed[] = [
  ...Array.from({ length: 10 }, (_, i) => ({
    caseNumber: `${i + 1} Cdo ${i + 1}/2024`,
    court: "Nejvyšší soud",
    createdAt: day(i),
    decisionDate: `2024-03-${String(i + 1).padStart(2, "0")}`,
    language: "cs",
    languageGroupKey: null,
    metadata:
      i === 0
        ? {
            keywords: ["nájem", "výpověď"],
            legalSentence: "  Právní   věta.  ",
          }
        : { keywords: ["smlouva"] },
  })),
  {
    caseNumber: "undated",
    court: "Nejvyšší soud",
    createdAt: day(20),
    decisionDate: null,
    language: "cs",
    languageGroupKey: null,
  },
  ...["cs", "en", "fr"].map((language, i) => ({
    caseNumber: "C-131/12",
    court: "Court of Justice",
    createdAt: day(30 + i),
    decisionDate: "2024-03-05",
    language,
    languageGroupKey: "ECLI:EU:C:2014:317",
  })),
];

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({ client });
  const readDb = async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the reads only use the role transaction's select surface.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      return await fn(tx);
    });
  // SAFETY: brand-only wrapper; the reads never inspect the marker.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  caseLawDb = readDb as unknown as CaseLawPublicReadDb;

  await db
    .insert(caseLawSources)
    .values([
      caseLawSourceRow({ adapterKey: "browse", id: sourceId, name: "browse" }),
    ]);
  await db.insert(caseLawDecisions).values(
    seeds.map((seed) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: seed.caseNumber,
      court: seed.court,
      country: "CZE",
      language: seed.language,
      languageGroupKey: seed.languageGroupKey,
      decisionDate: seed.decisionDate,
      createdAt: seed.createdAt,
      metadata: seed.metadata ?? {},
    })),
  );
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

const walk = async (limit: number) => {
  const items = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page depends on the previous cursor
    const result = await listDecisionsHandler(
      { limit, ...(cursor === undefined ? {} : { cursor }) },
      caseLawDb,
    );
    if (!("items" in result)) {
      throw new Error("list failed");
    }
    items.push(...result.items);
    if (result.nextCursor === null) {
      break;
    }
    cursor = result.nextCursor;
  }
  return items;
};

test(
  "browse pages walk newest first, undated last, one row per multilingual decision, without repeats or gaps",
  async () => {
    const all = await walk(3);
    const dates = all.map((item) => item.decisionDate);

    // Twelve rows: ten dated, the CJEU judgment once, the undated one last.
    expect(all).toHaveLength(12);
    expect(new Set(all.map((item) => item.id)).size).toBe(12);
    expect(dates.at(-1)).toBeNull();
    const dated = dates.slice(0, -1).map((date) => date ?? "");
    expect(dated).toEqual([...dated].toSorted().toReversed());
    const judgment = all.filter((item) => item.caseNumber === "C-131/12");
    expect(judgment).toHaveLength(1);
    expect(judgment[0]?.languageAlternates.map((a) => a.language)).toEqual([
      "cs",
      "en",
      "fr",
    ]);
    // The same walk in one page agrees with the paged walk.
    expect((await walk(50)).map((item) => item.id)).toEqual(
      all.map((item) => item.id),
    );
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the headnote is the legal sentence first, else the keywords, whitespace collapsed",
  async () => {
    const all = await walk(50);
    const first = all.find((item) => item.caseNumber === "1 Cdo 1/2024");
    const second = all.find((item) => item.caseNumber === "2 Cdo 2/2024");
    const undated = all.find((item) => item.caseNumber === "undated");

    expect(first?.headnote).toBe("Právní věta.");
    expect(second?.headnote).toBe("smlouva");
    expect(undated?.headnote).toBeNull();
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a tampered cursor is rejected, not silently restarted",
  async () => {
    const result = await listDecisionsHandler(
      { cursor: "not-a-cursor" },
      caseLawDb,
    );
    expect("items" in result).toBe(false);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the shelf lists each court's newest decisions once per judgment",
  async () => {
    const shelf = await readLatestDecisionsByCourt({
      caseLawDb,
      country: "CZE",
      courts: ["Nejvyšší soud", "Court of Justice", "No such court"],
    });
    // A court without decisions is left off the shelf, not shown empty.
    expect(shelf.map((group) => group.court)).toEqual([
      "Nejvyšší soud",
      "Court of Justice",
    ]);
    const byCourt = new Map(
      shelf.map((group) => [group.court, group.decisions]),
    );
    const supreme = byCourt.get("Nejvyšší soud");
    const cjeu = byCourt.get("Court of Justice");

    expect(supreme?.map((d) => d.decisionDate)).toEqual([
      "2024-03-10",
      "2024-03-09",
      "2024-03-08",
      "2024-03-07",
      "2024-03-06",
    ]);
    expect(cjeu).toHaveLength(1);
    expect(cjeu?.[0]?.languageAlternates).toHaveLength(3);
  },
  DB_TEST_TIMEOUT_MS,
);
