import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  DECISION_DOCKET_GRAMMARS,
  type DecisionDocketJurisdiction,
} from "@stll/api-contract/decision-docket-grammar";
import {
  DECISION_DOCKET_IDENTITY_FIXTURES,
  DOCKET_IDENTITY_FIXTURE_NUMBER_MAX,
  DOCKET_IDENTITY_PART_NUMERAL,
} from "@stll/api-contract/decision-docket-identity.fixtures";
import { DECISION_DOCKETS_STORED_WITH_SHEETS } from "@stll/api-contract/decision-docket-reference";
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
    /** A sibling of the same file whose sheet no source states. */
    sheetUnknown: createSafeId<"caseLawDecision">(),
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
    /**
     * Siblings of the large file stored on its bare docket, so a sheet read
     * reaches them, whose sheets beyond the stored ones only a recorded sheet
     * or an ECLI states.
     */
    largeRecordedSheet: createSafeId<"caseLawDecision">(),
    largeEcliSheet: createSafeId<"caseLawDecision">(),
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
    decision(ids.sheetUnknown, dockets.sheets, administrative, "2011-03-01"),
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
    decision(
      ids.largeRecordedSheet,
      dockets.large,
      administrative,
      "2015-01-01",
      null,
      { sheetNumber: String(LARGE_FILE_SIZE + 2) },
    ),
    decision(
      ids.largeEcliSheet,
      dockets.large,
      administrative,
      "2015-01-02",
      `ECLI:CZ:NSS:2015:7.AS.${n}.2014.${String(LARGE_FILE_SIZE + 3)}`,
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

const sorted = (...ids: SafeId<"caseLawDecision">[]): string[] =>
  ids.map(String).toSorted();

/**
 * What the public search's identity branch (`searched`) and the lookup tool
 * (`lookedUp`) answer an entry with, read under one jurisdiction's grammar.
 */
const identityReaders = (
  caseLawDb: () => CaseLawPublicReadDb,
  jurisdiction: DecisionDocketJurisdiction,
) => {
  const intentOf = (entry: string): DecisionIdentifierIntent => {
    const intent = parseDecisionQuery(entry, {
      grammar: DECISION_DOCKET_GRAMMARS[jurisdiction],
    });
    return intent.type === "identifier"
      ? intent
      : panic(`Not a ${jurisdiction} identifier: ${entry}`);
  };
  const searched = async (entry: string): Promise<string[]> =>
    (
      await findDecisionIdsByIdentity({
        caseLawDb: caseLawDb(),
        country: jurisdiction,
        identity: intentOf(entry),
      })
    )
      .map(String)
      .toSorted();
  const rowsRead = async (intent: DecisionIdentifierIntent) =>
    await lookupDecisionsByIdentity({
      caseLawDb: caseLawDb(),
      country: jurisdiction,
      locator: decisionIdentityLocatorOf(intent),
    });
  const lookedUp = async (entry: string) => {
    const intent = intentOf(entry);
    return resolveDecisionIdentity(intent, await rowsRead(intent));
  };
  /** The rows the lookup's read reaches, before it resolves among them. */
  const read = async (entry: string): Promise<string[]> =>
    (await rowsRead(intentOf(entry))).map(({ id }) => String(id)).toSorted();
  return { searched, lookedUp, read };
};

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
  const { lookedUp, read, searched } = identityReaders(
    () => context().caseLawDb,
    "CZE",
  );

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
          status: "incomplete_identifier",
          missing: ["sheet"],
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
        status: "incomplete_identifier",
        missing: ["sheet"],
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
          status: "incomplete_identifier",
          missing: ["sheet"],
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

    test("a sheet the corpus does not hold returns the siblings whose sheet is unknown, never one under another sheet", async () => {
      // Each other sibling's sheet is known from a different source (ECLI,
      // parallel identifier, recorded sheet, published reference); every
      // source excludes alike.
      const { dockets, ids } = context().scenario;
      for (const entry of [
        `${dockets.sheets} - 50`,
        `${dockets.sheets}-8`,
        `${dockets.sheets}-9`,
      ]) {
        expect(await searched(entry), entry).toEqual(sorted(ids.sheetUnknown));
        expect(await lookedUp(entry), entry).toMatchObject({
          status: "ambiguous",
          reason: "selector_unmatched",
        });
      }
    });

    test("a sheet no sibling carries, every one known under another, answers nothing", async () => {
      // The siblings stored with their sheet are out of the read's reach; the
      // two stored on the bare docket are read, and their sheets are known
      // from a recorded sheet and an ECLI.
      const { dockets, ids, largeFile } = context().scenario;
      const entry = `${dockets.large}-${String(largeFile.length + 1)}`;
      expect(await read(entry)).toEqual(
        sorted(ids.largeRecordedSheet, ids.largeEcliSheet),
      );
      expect(await searched(entry)).toEqual([]);
      expect(await lookedUp(entry)).toEqual({ status: "none" });
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

/**
 * The court and language a jurisdiction's rows are stored under; `courtId`
 * is set exactly where the jurisdiction identifies courts by directory id,
 * as the table requires.
 */
const GRAMMAR_SCENARIO_COURTS = {
  AUT: { court: "Bundesverwaltungsgericht", courtId: null, language: "de" },
  CZE: { court: "Nejvyšší správní soud", courtId: null, language: "cs" },
  EU: { court: "Court of Justice", courtId: null, language: "en" },
  HUN: { court: "Kúria", courtId: null, language: "hu" },
  POL: { court: "Sąd Najwyższy", courtId: null, language: "pl" },
  SVK: {
    court: "Najvyšší súd Slovenskej republiky",
    courtId: null,
    language: "sk",
  },
  USA: {
    court: "Supreme Court of the United States",
    courtId: "scotus",
    language: "en",
  },
} as const satisfies Record<
  DecisionDocketJurisdiction,
  {
    readonly court: string;
    readonly courtId: string | null;
    readonly language: string;
  }
>;

/** The day a file's siblings were all issued. */
const SIBLING_DAY = "2020-08-24";

/**
 * One case file per declared docket grammar, from its identity fixture: a
 * plain decision, a sibling of the same day stored with a part numeral, one
 * stored with its sheet where the grammar has sheets, and a lone decision
 * under the next number. `number` is the fixtures' own (1 to
 * `DOCKET_IDENTITY_FIXTURE_NUMBER_MAX`), so a run on a shared database reads
 * only its own rows.
 */
export type DocketGrammarFamilyScenario = ReturnType<
  typeof docketGrammarFamilyScenario
>;

export const docketGrammarFamilyScenario = (number: number) => {
  if (
    !Number.isInteger(number) ||
    number < 1 ||
    number > DOCKET_IDENTITY_FIXTURE_NUMBER_MAX
  ) {
    return panic(
      `Fixture dockets are numbered 1 to ${String(DOCKET_IDENTITY_FIXTURE_NUMBER_MAX)}`,
    );
  }
  const files = Object.values(DECISION_DOCKET_GRAMMARS).map(
    ({ jurisdiction }) => {
      const fixture = DECISION_DOCKET_IDENTITY_FIXTURES[jurisdiction];
      const { sheet } = fixture;
      const filed = fixture.filed(number);
      const ids = {
        plain: createSafeId<"caseLawDecision">(),
        part: createSafeId<"caseLawDecision">(),
        sheet:
          sheet.type === "supported" ? createSafeId<"caseLawDecision">() : null,
        lone: createSafeId<"caseLawDecision">(),
      };
      const decisions = [
        { id: ids.plain, caseNumber: filed, decisionDate: SIBLING_DAY },
        {
          id: ids.part,
          caseNumber: `${filed} - ${DOCKET_IDENTITY_PART_NUMERAL}.`,
          decisionDate: SIBLING_DAY,
        },
        ...(sheet.type === "supported" && ids.sheet !== null
          ? [
              {
                id: ids.sheet,
                caseNumber: `${filed} - ${sheet.held}`,
                decisionDate: SIBLING_DAY,
              },
            ]
          : []),
        {
          id: ids.lone,
          caseNumber: fixture.filed(number + 1),
          decisionDate: "2021-03-01",
        },
      ];
      return { jurisdiction, fixture, filed, ids, decisions };
    },
  );
  return { number, files };
};

/** Every file's decision rows, keyed by the row writer's own columns. */
export const docketGrammarFamilyDecisionRows = (
  { files }: DocketGrammarFamilyScenario,
  sourceId: SafeId<"caseLawSource">,
): (typeof caseLawDecisions.$inferInsert)[] =>
  files.flatMap(({ decisions, jurisdiction }) => {
    const { court, courtId, language } = GRAMMAR_SCENARIO_COURTS[jurisdiction];
    return decisions.map(({ caseNumber, decisionDate, id }) => ({
      id,
      sourceId,
      ...decisionDocketColumns({
        caseNumber,
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        country: jurisdiction,
      }),
      court,
      courtId,
      country: jurisdiction,
      decisionDate,
      ecli: null,
      sourceDocumentId: `docket-grammar-family-${String(id)}`,
      language,
      languageGroupKey: `docket-grammar-family-${String(id)}`,
      metadata: {},
    }));
  });

/**
 * Registers, for every declared grammar, what a bare docket, a part and a
 * sheet answer with against its file. `context` is read when a test runs.
 */
export const describeDocketGrammarFamilyIdentity = (
  context: () => {
    caseLawDb: CaseLawPublicReadDb;
    scenario: DocketGrammarFamilyScenario;
  },
): void => {
  describe.each(
    Object.values(DECISION_DOCKET_GRAMMARS).map(
      ({ jurisdiction }) => jurisdiction,
    ),
  )("a %s case file", (jurisdiction) => {
    const { lookedUp, searched } = identityReaders(
      () => context().caseLawDb,
      jurisdiction,
    );
    const fileOf = () =>
      context().scenario.files.find(
        (file) => file.jurisdiction === jurisdiction,
      ) ?? panic(`The scenario holds no ${jurisdiction} file`);
    const siblingIds = ({ ids }: ReturnType<typeof fileOf>) =>
      sorted(ids.plain, ids.part, ...(ids.sheet === null ? [] : [ids.sheet]));

    test("a bare docket in every reader spelling names the whole file", async () => {
      const file = fileOf();
      const { fixture, filed } = file;
      for (const entry of [
        filed,
        ...fixture.readerSpellings(context().scenario.number),
      ]) {
        expect(await searched(entry), entry).toEqual(siblingIds(file));
        expect(await lookedUp(entry), entry).toMatchObject({
          status: "ambiguous",
          reason: "several",
        });
      }
    });

    test("the part on a stored docket names exactly its sibling", async () => {
      const { filed, ids } = fileOf();
      const entry = `${filed} - ${DOCKET_IDENTITY_PART_NUMERAL}.`;
      expect(await searched(entry)).toEqual(sorted(ids.part));
      expect(await lookedUp(entry)).toMatchObject({
        status: "unique",
        basis: "selector",
      });
    });

    // A grammar with no sheet declares why in its fixture, and the grammar
    // tests hold it to that.
    const { sheet } = DECISION_DOCKET_IDENTITY_FIXTURES[jurisdiction];
    if (sheet.type === "supported") {
      test("a sheet names exactly its sibling, and an unheld one every sibling not under another sheet", async () => {
        const { filed, ids } = fileOf();
        const held = `${filed}-${sheet.held}`;
        expect(await searched(held)).toEqual(
          sorted(ids.sheet ?? panic("A sheet file without its sibling")),
        );
        expect(await lookedUp(held)).toMatchObject({
          status: "unique",
          basis: "selector",
        });
        // The sibling stored under another sheet is known not to be the one
        // asked for; every sibling whose sheet is unknown still answers.
        const unheld = `${filed}-${sheet.unheld}`;
        expect(await searched(unheld)).toEqual(sorted(ids.plain, ids.part));
        expect(await lookedUp(unheld)).toMatchObject({
          status: "ambiguous",
          reason: "selector_unmatched",
        });
      });
    }

    test("a lone decision is claimed only where no sibling can hide under a sheet", async () => {
      const { fixture, ids } = fileOf();
      const entry = fixture.filed(context().scenario.number + 1);
      expect(await searched(entry)).toEqual(sorted(ids.lone));
      expect(await lookedUp(entry)).toMatchObject(
        DECISION_DOCKETS_STORED_WITH_SHEETS[jurisdiction]
          ? { status: "incomplete_identifier", missing: ["sheet"] }
          : { status: "unique", basis: "docket" },
      );
    });
  });
};
