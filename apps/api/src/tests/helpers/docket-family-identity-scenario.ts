import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import {
  type DecisionIdentifierIntent,
  parseDecisionQuery,
  resolveDecisionIdentity,
} from "@stll/api-contract/decision-query-intent";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
} from "@/api/db/schema";
import {
  decisionIdentityLocatorOf,
  lookupDecisionsByIdentity,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { findDecisionIdsByIdentity } from "@/api/handlers/case-law/decisions/search";
import { normalizeDecisionIdentifierValueIn } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { decisionDocketColumns } from "@/api/handlers/case-law/ingestion/pipeline/decision-docket-columns";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { LIMITS } from "@/api/lib/limits";

/**
 * Decisions that share a case file, as ingestion stores them, and what the
 * identity read must answer about them. Run against PGlite and, in the
 * Postgres job, against a real server, so both engines read the same keys.
 *
 * A docket names a file, and a file can hold several decisions, some issued
 * on one day. A bare docket must answer with the whole file, a sheet, a part
 * or an ECLI with exactly its decision, and nothing in between may pick a
 * sibling. Every docket number is the scenario's own `number`, so a run on a
 * shared database reads only its own rows.
 */
export type DocketFamilyScenario = ReturnType<typeof docketFamilyScenario>;

/** A file with more decisions than one identity read keeps. */
const LARGE_FILE_SIZE = LIMITS.caseLawSearchPageSizeMax + 20;

/**
 * The public reader's grant on the case-file key. It ships a release after
 * the column, so the suites set it as that release will, and take it away to
 * read as a reader that does not hold it yet.
 */
export const docketFamilyKeyGrantSql = (mode: "grant" | "revoke") =>
  mode === "grant"
    ? sql`GRANT SELECT (docket_family_key) ON TABLE case_law_decisions TO stella_public_law_reader`
    : sql`REVOKE SELECT (docket_family_key) ON TABLE case_law_decisions FROM stella_public_law_reader`;

export const docketFamilyScenario = (number: number) => {
  const n = String(number);
  const ids = {
    /** Two decisions of one file, one day, told apart by ECLI and a part. */
    partOne: createSafeId<"caseLawDecision">(),
    plainSibling: createSafeId<"caseLawDecision">(),
    /** Three decisions of one administrative file, years apart, by sheet. */
    sheet86: createSafeId<"caseLawDecision">(),
    sheet98: createSafeId<"caseLawDecision">(),
    sheet109: createSafeId<"caseLawDecision">(),
    /** Siblings whose sheet only their source's recorded reference states. */
    sheet120: createSafeId<"caseLawDecision">(),
    sheet131: createSafeId<"caseLawDecision">(),
    /** One file, two decisions on different dates, nothing else to tell. */
    earlier: createSafeId<"caseLawDecision">(),
    later: createSafeId<"caseLawDecision">(),
    /** A row whose stored docket still carries its sheet, and a sibling. */
    legacySheet: createSafeId<"caseLawDecision">(),
    legacySibling: createSafeId<"caseLawDecision">(),
    /** A file of which the corpus holds one decision. */
    lone: createSafeId<"caseLawDecision">(),
    /** A file whose rows no write has keyed yet, one stored with its sheet. */
    unkeyedBare: createSafeId<"caseLawDecision">(),
    unkeyedSheet: createSafeId<"caseLawDecision">(),
    /** The same number at a regional court: another court's file. */
    regional: createSafeId<"caseLawDecision">(),
  };
  const dockets = {
    sameDay: `7 Tdo ${n}/2020`,
    sheets: `3 Afs ${n}/2008`,
    dated: `5 Cdo ${n}/2015`,
    legacy: `4 As ${n}/2012`,
    lone: `12 Cdo ${n}/2021`,
    unkeyed: `9 As ${n}/2013`,
    large: `7 As ${n}/2014`,
  };
  /** Each decision of the large file, stored with its sheet, latest last. */
  const largeFile = Array.from({ length: LARGE_FILE_SIZE }, () =>
    createSafeId<"caseLawDecision">(),
  );
  const decision = (
    id: SafeId<"caseLawDecision">,
    caseNumber: string,
    court: string,
    decisionDate: string,
    ecli: string | null = null,
    metadata: Record<string, string> = {},
    keyed = true,
  ) => ({ id, caseNumber, court, decisionDate, ecli, metadata, keyed });
  const supreme = "Nejvyšší soud";
  const administrative = "Nejvyšší správní soud";
  const decisions = [
    // The publisher's document carried no key of its own, so the part it
    // printed stayed on the stored docket.
    decision(
      ids.partOne,
      `${dockets.sameDay}- I.`,
      supreme,
      "2020-08-24",
      `ECLI:CZ:NS:2020:7.TDO.${n}.2020.2`,
    ),
    decision(
      ids.plainSibling,
      dockets.sameDay,
      supreme,
      "2020-08-24",
      `ECLI:CZ:NS:2020:7.TDO.${n}.2020.4`,
    ),
    decision(
      ids.sheet86,
      dockets.sheets,
      administrative,
      "2008-07-22",
      `ECLI:CZ:NSS:2008:3.AFS.${n}.2008.86`,
    ),
    decision(
      ids.sheet98,
      dockets.sheets,
      administrative,
      "2010-01-12",
      `ECLI:CZ:NSS:2010:3.AFS.${n}.2008.98`,
    ),
    // No ECLI to read the sheet from: the publisher supplied the full file
    // number as a parallel identifier instead.
    decision(ids.sheet109, dockets.sheets, administrative, "2010-02-09"),
    // No ECLI and no parallel identifier: the adapter recorded the sheet it
    // split off the court's reference, alone or with the reference itself.
    decision(ids.sheet120, dockets.sheets, administrative, "2010-05-03", null, {
      sheetNumber: "120",
    }),
    decision(ids.sheet131, dockets.sheets, administrative, "2010-06-14", null, {
      publishedCaseNumber: `${dockets.sheets} - 131`,
    }),
    decision(ids.earlier, dockets.dated, supreme, "2015-03-01"),
    decision(ids.later, dockets.dated, supreme, "2016-09-30"),
    decision(ids.regional, dockets.dated, "Krajský soud v Brně", "2015-03-01"),
    decision(
      ids.legacySheet,
      `${dockets.legacy} - 33`,
      administrative,
      "2012-05-02",
    ),
    decision(
      ids.legacySibling,
      dockets.legacy,
      administrative,
      "2012-11-20",
      `ECLI:CZ:NSS:2012:4.AS.${n}.2012.40`,
    ),
    decision(
      ids.lone,
      dockets.lone,
      supreme,
      "2022-01-11",
      `ECLI:CZ:NS:2022:12.CDO.${n}.2021.1`,
    ),
    // Stored before the case-file key existed and not backfilled yet.
    decision(
      ids.unkeyedBare,
      dockets.unkeyed,
      administrative,
      "2013-03-04",
      null,
      {},
      false,
    ),
    decision(
      ids.unkeyedSheet,
      `${dockets.unkeyed} - 12`,
      administrative,
      "2013-06-10",
      null,
      {},
      false,
    ),
    ...largeFile.map((id, index) =>
      decision(
        id,
        `${dockets.large}-${String(index + 1)}`,
        administrative,
        new Date(Date.UTC(2014, 0, 1 + index)).toISOString().slice(0, 10),
      ),
    ),
  ];
  return { ids, dockets, decisions, largeFile, number };
};

/**
 * The decision rows as ingestion writes them, keyed from the stored docket by
 * the row writer's own columns; an unkeyed row is one stored before the
 * case-file key existed.
 */
export const docketFamilyDecisionRows = (
  scenario: DocketFamilyScenario,
  sourceId: SafeId<"caseLawSource">,
): (typeof caseLawDecisions.$inferInsert)[] =>
  scenario.decisions.map(
    ({ caseNumber, court, decisionDate, ecli, id, keyed, metadata }) => ({
      id,
      sourceId,
      ...decisionDocketColumns({
        caseNumber,
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        country: "CZE",
      }),
      ...(keyed ? {} : { docketFamilyKey: null }),
      court,
      country: "CZE",
      decisionDate,
      ecli,
      // Each decision is its own publisher document, as a file's siblings are.
      sourceDocumentId: `docket-family-${String(id)}`,
      language: "cs",
      languageGroupKey: `docket-family-${String(id)}`,
      metadata,
    }),
  );

/** Parallel identifiers holding a file number with its sheet. */
export const docketFamilyIdentifierRows = ({
  dockets,
  ids,
}: DocketFamilyScenario): (typeof caseLawDecisionIdentifiers.$inferInsert)[] =>
  (
    [
      [ids.sheet98, `${dockets.sheets} - 98`],
      [ids.sheet109, `${dockets.sheets} - 109`],
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
  }));

const intentOf = (entry: string): DecisionIdentifierIntent => {
  const intent = parseDecisionQuery(entry, {
    grammar: DECISION_DOCKET_GRAMMARS.CZE,
  });
  return intent.type === "identifier"
    ? intent
    : panic(`Not an identifier: ${entry}`);
};

const sorted = (...ids: SafeId<"caseLawDecision">[]): string[] =>
  ids.map(String).toSorted();

/**
 * Registers the scenario's tests. `context` is read when a test runs, after
 * the caller's setup has seeded the rows.
 */
export const describeDocketFamilyIdentity = (
  context: () => {
    caseLawDb: CaseLawPublicReadDb;
    scenario: DocketFamilyScenario;
    /** Sets the reader's grant on the case-file key, as its owner. */
    setFamilyKeyGrant: (mode: "grant" | "revoke") => Promise<void>;
  },
): void => {
  /** What the public search's identity branch answers an entry with. */
  const searched = async (entry: string): Promise<string[]> =>
    (
      await findDecisionIdsByIdentity({
        caseLawDb: context().caseLawDb,
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
      caseLawDb: context().caseLawDb,
      country: "CZE",
      locator: decisionIdentityLocatorOf(intent),
    });
    return resolveDecisionIdentity(intent, rows);
  };

  describe("a bare docket names its whole file", () => {
    test("siblings of one day both come back, typed ambiguous", async () => {
      const { dockets, ids } = context().scenario;
      for (const entry of [
        dockets.sameDay,
        `sp. zn. ${dockets.sameDay}`,
        dockets.sameDay.replaceAll(" ", ""),
        dockets.sameDay.replace("/", " / "),
        `dovolání ${dockets.sameDay}`,
      ]) {
        expect(await searched(entry), entry).toEqual(
          sorted(ids.partOne, ids.plainSibling),
        );
        expect(await lookedUp(entry), entry).toMatchObject({
          status: "ambiguous",
          reason: "several",
        });
      }
    });

    test("decisions of one file on different dates are never collapsed", async () => {
      const { dockets, ids } = context().scenario;
      // The regional court's file under the same number stays a candidate
      // too: a docket is unique to a court, not to the corpus.
      expect(await searched(dockets.dated)).toEqual(
        sorted(ids.earlier, ids.later, ids.regional),
      );
      expect(await lookedUp(dockets.dated)).toMatchObject({
        status: "ambiguous",
      });
    });

    test("a sibling stored with its sheet comes back by its case-file key", async () => {
      // Its docket keys apart from the file's, but its case-file key does not.
      const { dockets, ids } = context().scenario;
      for (const entry of [dockets.legacy, `sp. zn. ${dockets.legacy}`]) {
        expect(await searched(entry), entry).toEqual(
          sorted(ids.legacySheet, ids.legacySibling),
        );
        expect(await lookedUp(entry), entry).toMatchObject({
          status: "ambiguous",
          reason: "several",
        });
      }
    });

    test("a reader without the case-file key's grant reads the file by its spellings", async () => {
      // The release before the grant: no error, and no claim the file is whole.
      const { dockets, ids } = context().scenario;
      await context().setFamilyKeyGrant("revoke");
      try {
        expect(await searched(dockets.legacy)).toEqual(
          sorted(ids.legacySibling),
        );
        expect(await lookedUp(dockets.legacy)).toMatchObject({
          status: "ambiguous",
          reason: "file_incomplete",
        });
      } finally {
        await context().setFamilyKeyGrant("grant");
      }
    });

    test("a row not keyed yet is still found by its docket spelling", async () => {
      // The sibling stored with its sheet is reachable only by its key, which
      // its row does not hold yet: the read cannot prove the file whole.
      const { dockets, ids } = context().scenario;
      expect(await searched(dockets.unkeyed)).toEqual(sorted(ids.unkeyedBare));
      expect(await lookedUp(dockets.unkeyed)).toMatchObject({
        status: "ambiguous",
        reason: "file_incomplete",
      });
      expect(await searched(`${dockets.unkeyed} - 12`)).toEqual(
        sorted(ids.unkeyedSheet),
      );
    });

    test("a lone decision found by a bare docket is listed, never claimed", async () => {
      // Rows stored before the case-file key existed may hold a sibling the
      // key cannot reach yet, so a read by the docket cannot prove the file
      // holds one decision.
      const { dockets, ids } = context().scenario;
      for (const entry of [
        dockets.lone,
        `sp. zn. ${dockets.lone}`,
        dockets.lone.replace("/", " / "),
        `${dockets.lone} rozsudek`,
      ]) {
        expect(await searched(entry), entry).toEqual(sorted(ids.lone));
        expect(await lookedUp(entry), entry).toMatchObject({
          status: "ambiguous",
          reason: "file_incomplete",
        });
      }
    });
  });

  describe("a sheet, a part or an ECLI names exactly its decision", () => {
    test("an explicit ECLI selects one sibling of one day", async () => {
      const { ids, number } = context().scenario;
      const n = String(number);
      expect(await searched(`ECLI:CZ:NS:2020:7.TDO.${n}.2020.2`)).toEqual(
        sorted(ids.partOne),
      );
      expect(await searched(`ecli:cz:ns:2020:7.tdo.${n}.2020.4`)).toEqual(
        sorted(ids.plainSibling),
      );
    });

    test("the part on a stored docket selects its sibling", async () => {
      const { dockets, ids } = context().scenario;
      expect(await searched(`${dockets.sameDay} - I.`)).toEqual(
        sorted(ids.partOne),
      );
      expect(await lookedUp(`${dockets.sameDay}- I.`)).toMatchObject({
        status: "unique",
        basis: "selector",
      });
    });

    test("a general court's ECLI sequence number is not a sheet", async () => {
      // `….2` and `….4` count the file's decisions; a printed `-4` is a
      // sheet, which neither is known to carry.
      const { dockets, ids } = context().scenario;
      expect(await searched(`${dockets.sameDay}-4`)).toEqual(
        sorted(ids.partOne, ids.plainSibling),
      );
      expect(await lookedUp(`${dockets.sameDay}-4`)).toMatchObject({
        status: "ambiguous",
        reason: "selector_unmatched",
      });
      expect(await lookedUp(`č. j. ${dockets.lone}-1`)).toMatchObject({
        status: "ambiguous",
        reason: "selector_unmatched",
      });
    });

    test("each sheet of an administrative file resolves to its own decision", async () => {
      const { dockets, ids } = context().scenario;
      for (const [entry, id] of [
        [`${dockets.sheets} - 86`, ids.sheet86],
        [`${dockets.sheets} – 98`, ids.sheet98],
        [`č. j. ${dockets.sheets}–109 ze dne`, ids.sheet109],
        [`${dockets.sheets}-0098`, ids.sheet98],
        [`${dockets.sheets} - 120`, ids.sheet120],
        [`${dockets.sheets}-131`, ids.sheet131],
      ] as const) {
        expect(await searched(entry), entry).toEqual(sorted(id));
        expect(await lookedUp(entry), entry).toMatchObject({
          status: "unique",
          basis: "selector",
        });
      }
    });

    test("a sheet names its decision in a file larger than a read keeps", async () => {
      // The whole file would outgrow the candidates before the sheet is
      // applied; a sheet reads its decision's own spellings instead.
      const { dockets, largeFile } = context().scenario;
      const named =
        largeFile.at(-1) ?? panic("The large file holds no decision");
      const entry = `${dockets.large}-${String(largeFile.length)}`;
      expect(await searched(entry)).toEqual(sorted(named));
      expect(await lookedUp(entry)).toMatchObject({
        status: "unique",
        basis: "selector",
      });
    });

    test("a sheet the corpus does not hold returns the file, never a sibling", async () => {
      const { dockets, ids } = context().scenario;
      for (const entry of [
        `${dockets.sheets} - 50`,
        `${dockets.sheets}-8`,
        `${dockets.sheets}-9`,
      ]) {
        expect(await searched(entry), entry).toEqual(
          sorted(
            ids.sheet86,
            ids.sheet98,
            ids.sheet109,
            ids.sheet120,
            ids.sheet131,
          ),
        );
        expect(await lookedUp(entry), entry).toMatchObject({
          status: "ambiguous",
          reason: "selector_unmatched",
        });
      }
    });

    test("a row that still stores its sheet is found by it", async () => {
      // The full file number reaches the row whose stored docket kept it;
      // the sibling answers to the sheet its ECLI carries.
      const { dockets, ids } = context().scenario;
      expect(await searched(`${dockets.legacy} - 33`)).toEqual(
        sorted(ids.legacySheet),
      );
      expect(await searched(`${dockets.legacy}-40`)).toEqual(
        sorted(ids.legacySibling),
      );
    });
  });
};
