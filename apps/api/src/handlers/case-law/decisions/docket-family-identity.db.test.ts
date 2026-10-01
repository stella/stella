import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import {
  type DecisionIdentifierIntent,
  parseDecisionQuery,
  resolveDecisionIdentity,
} from "@stll/api-contract/decision-query-intent";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  decisionIdentityLocatorOf,
  lookupDecisionsByIdentity,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { findDecisionIdsByIdentity } from "@/api/handlers/case-law/decisions/search";
import {
  citationKeyOf,
  normalizeDecisionIdentifierValueIn,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
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

/**
 * A docket names a case file, and a file can hold several decisions, some
 * issued on one day. These run the identity read on a real Postgres, as the
 * public search and the lookup tool both reach it, and check that a bare
 * docket answers with the whole file, that a sheet, a part or an ECLI answers
 * with exactly its decision, and that nothing in between picks a sibling.
 */

const sourceId = createSafeId<"caseLawSource">();

/** Two decisions of one file, one day, told apart by ECLI and by a part. */
const partOneId = createSafeId<"caseLawDecision">();
const plainSiblingId = createSafeId<"caseLawDecision">();
/** Three decisions of one administrative file, years apart, by sheet. */
const sheet86Id = createSafeId<"caseLawDecision">();
const sheet98Id = createSafeId<"caseLawDecision">();
const sheet109Id = createSafeId<"caseLawDecision">();
/** One file, two decisions on different dates, nothing else to tell them by. */
const earlierId = createSafeId<"caseLawDecision">();
const laterId = createSafeId<"caseLawDecision">();
/** A legacy row whose stored docket still carries its sheet, and a sibling. */
const legacySheetId = createSafeId<"caseLawDecision">();
const legacySiblingId = createSafeId<"caseLawDecision">();
/** A file of one decision. */
const loneId = createSafeId<"caseLawDecision">();
/** The same number at a regional court: another court's file. */
const regionalId = createSafeId<"caseLawDecision">();

const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

type SeedRow = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  court: string;
  decisionDate: string;
  ecli?: string | null;
  sheetNumber?: string | null;
};

/** A row as ingestion writes it: the citation key keyed from the stored docket. */
const decisionRow = ({
  caseNumber,
  court,
  decisionDate,
  ecli = null,
  id,
  sheetNumber = null,
}: SeedRow) => ({
  id,
  sourceId,
  caseNumber,
  citationKey: citationKeyOf(caseNumber),
  court,
  country: "CZE",
  decisionDate,
  ecli,
  sheetNumber,
  // Each decision is its own publisher document, as siblings of one file are.
  sourceDocumentId: `document-${String(id)}`,
  language: "cs",
  languageGroupKey: `family-${String(id)}`,
});

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the reads use.
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
        caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      ]);
    await db.insert(caseLawDecisions).values([
      decisionRow({
        id: partOneId,
        // The publisher's document carried no key of its own, so the part it
        // printed stayed on the stored docket.
        caseNumber: "7 Tdo 100/2020- I.",
        court: "Nejvyšší soud",
        decisionDate: "2020-08-24",
        ecli: "ECLI:CZ:NS:2020:7.TDO.100.2020.2",
      }),
      decisionRow({
        id: plainSiblingId,
        caseNumber: "7 Tdo 100/2020",
        court: "Nejvyšší soud",
        decisionDate: "2020-08-24",
        ecli: "ECLI:CZ:NS:2020:7.TDO.100.2020.4",
      }),
      decisionRow({
        id: sheet86Id,
        caseNumber: "3 Afs 41/2008",
        court: "Nejvyšší správní soud",
        decisionDate: "2008-07-22",
        ecli: "ECLI:CZ:NSS:2008:3.AFS.41.2008.86",
        sheetNumber: "86",
      }),
      decisionRow({
        id: sheet98Id,
        caseNumber: "3 Afs 41/2008",
        court: "Nejvyšší správní soud",
        decisionDate: "2010-01-12",
        ecli: "ECLI:CZ:NSS:2010:3.AFS.41.2008.98",
        sheetNumber: "98",
      }),
      decisionRow({
        id: sheet109Id,
        caseNumber: "3 Afs 41/2008",
        court: "Nejvyšší správní soud",
        decisionDate: "2010-02-09",
        // No ECLI to read the sheet from: the publisher supplied the full
        // file number as a parallel identifier instead.
        ecli: null,
        sheetNumber: "109",
      }),
      decisionRow({
        id: earlierId,
        caseNumber: "5 Cdo 300/2015",
        court: "Nejvyšší soud",
        decisionDate: "2015-03-01",
      }),
      decisionRow({
        id: laterId,
        caseNumber: "5 Cdo 300/2015",
        court: "Nejvyšší soud",
        decisionDate: "2016-09-30",
      }),
      decisionRow({
        id: legacySheetId,
        caseNumber: "4 As 50/2012 - 33",
        court: "Nejvyšší správní soud",
        decisionDate: "2012-05-02",
      }),
      decisionRow({
        id: legacySiblingId,
        caseNumber: "4 As 50/2012",
        court: "Nejvyšší správní soud",
        decisionDate: "2012-11-20",
        ecli: "ECLI:CZ:NSS:2012:4.AS.50.2012.40",
      }),
      decisionRow({
        id: loneId,
        caseNumber: "12 Cdo 3456/2021",
        court: "Nejvyšší soud",
        decisionDate: "2022-01-11",
        ecli: "ECLI:CZ:NS:2022:12.CDO.3456.2021.1",
      }),
      decisionRow({
        id: regionalId,
        caseNumber: "5 Cdo 300/2015",
        court: "Krajský soud v Brně",
        decisionDate: "2015-03-01",
      }),
    ]);
    // Parallel identifiers holding the file number with its sheet, as a
    // publisher that supplies it leaves it.
    await db.insert(caseLawDecisionIdentifiers).values(
      (
        [
          [sheet98Id, "3 Afs 41/2008 - 98"],
          [sheet109Id, "3 Afs 41/2008 - 109"],
        ] as const
      ).map(([decisionId, value]) => ({
        decisionId,
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value,
        normalizedValue: normalizeDecisionIdentifierValueIn(
          "CZE",
          DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          value,
        ),
      })),
    );
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

const intentOf = (entry: string): DecisionIdentifierIntent => {
  const intent = parseDecisionQuery(entry, {
    grammar: DECISION_DOCKET_GRAMMARS.CZE,
  });
  return intent.type === "identifier"
    ? intent
    : panic(`Not an identifier: ${entry}`);
};

/** What the public search's identity branch answers an entry with. */
const searched = async (entry: string): Promise<string[]> =>
  (
    await findDecisionIdsByIdentity({
      caseLawDb,
      country: "CZE",
      identity: intentOf(entry),
    })
  )
    .map(String)
    .toSorted();

/** What the lookup tool resolves an entry to. */
const lookedUp = async (entry: string) => {
  const intent = intentOf(entry);
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: decisionIdentityLocatorOf(intent),
  });
  return resolveDecisionIdentity(intent, rows);
};

const sorted = (...ids: SafeId<"caseLawDecision">[]): string[] =>
  ids.map(String).toSorted();

describe("a bare docket names its whole file", () => {
  test("siblings of one day both come back, typed ambiguous", async () => {
    for (const entry of [
      "7 Tdo 100/2020",
      "sp. zn. 7 Tdo 100/2020",
      "7Tdo100/2020",
      "7 Tdo 100 / 2020",
      "dovolání 7 Tdo 100/2020",
    ]) {
      expect(await searched(entry), entry).toEqual(
        sorted(partOneId, plainSiblingId),
      );
      const resolution = await lookedUp(entry);
      expect(resolution, entry).toMatchObject({
        status: "ambiguous",
        reason: "several",
      });
    }
  });

  test("decisions of one file on different dates are never collapsed", async () => {
    // The regional court's file under the same number stays a candidate too:
    // a docket is unique to a court, not to the corpus.
    expect(await searched("5 Cdo 300/2015")).toEqual(
      sorted(earlierId, laterId, regionalId),
    );
    expect(await lookedUp("5 Cdo 300/2015")).toMatchObject({
      status: "ambiguous",
    });
  });

  test("a file of one decision is found however the reference is spelled", async () => {
    for (const entry of [
      "12 Cdo 3456/2021",
      "sp. zn. 12 Cdo 3456/2021",
      "12Cdo3456/2021",
      "12 Cdo 3456 / 2021",
      "12 Cdo 3456/2021 rozsudek",
      "č. j. 12 Cdo 3456/2021-1",
    ]) {
      expect(await searched(entry), entry).toEqual(sorted(loneId));
      const resolution = await lookedUp(entry);
      expect(resolution.status, entry).toBe("unique");
    }
  });
});

describe("a sheet, a part or an ECLI names exactly its decision", () => {
  test("an explicit ECLI selects one sibling of one day", async () => {
    expect(await searched("ECLI:CZ:NS:2020:7.TDO.100.2020.2")).toEqual(
      sorted(partOneId),
    );
    expect(await searched("ecli:cz:ns:2020:7.tdo.100.2020.4")).toEqual(
      sorted(plainSiblingId),
    );
  });

  test("the part on a stored docket, or the ECLI's sheet, selects its sibling", async () => {
    expect(await searched("7 Tdo 100/2020 - I.")).toEqual(sorted(partOneId));
    expect(await searched("7 Tdo 100/2020-4")).toEqual(sorted(plainSiblingId));
    expect(await lookedUp("7 Tdo 100/2020- I.")).toMatchObject({
      status: "unique",
      basis: "selector",
    });
  });

  test("each sheet of an administrative file resolves to its own decision", async () => {
    for (const [entry, id] of [
      ["3 Afs 41/2008 - 86", sheet86Id],
      ["3 Afs 41/2008 – 98", sheet98Id],
      ["č. j. 3 Afs 41/2008–109 ze dne", sheet109Id],
      ["3 Afs 41/2008-0098", sheet98Id],
    ] as const) {
      expect(await searched(entry), entry).toEqual(sorted(id));
      const resolution = await lookedUp(entry);
      expect(resolution, entry).toMatchObject({
        status: "unique",
        basis: "selector",
      });
    }
  });

  test("a sheet the corpus does not hold returns the file, never a sibling", async () => {
    for (const entry of [
      "3 Afs 41/2008 - 50",
      "3 Afs 41/2008-8",
      "3 Afs 41/2008-9",
    ]) {
      expect(await searched(entry), entry).toEqual(
        sorted(sheet86Id, sheet98Id, sheet109Id),
      );
      expect(await lookedUp(entry), entry).toMatchObject({
        status: "ambiguous",
        reason: "selector_unmatched",
      });
    }
  });

  test("a legacy row that still stores its sheet is found by it", async () => {
    // The bare file number reaches the sibling through the file's key; the
    // full file number also reaches the row whose stored docket kept it.
    expect(await searched("4 As 50/2012 - 33")).toEqual(sorted(legacySheetId));
    expect(await searched("4 As 50/2012-40")).toEqual(sorted(legacySiblingId));
  });
});

test("an entry naming two files is not read as either", () => {
  expect(
    parseDecisionQuery("7 Tdo 100/2020 a 5 Cdo 300/2015", {
      grammar: DECISION_DOCKET_GRAMMARS.CZE,
    }).type,
  ).toBe("text");
});
