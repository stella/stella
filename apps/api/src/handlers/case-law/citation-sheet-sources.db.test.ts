import { panic } from "better-result";
/**
 * A decision's sheet is known from any of `DECISION_SHEET_SOURCES`, and
 * which of them carries it never changes which decision a lookup says a
 * reference names. The citation resolver's SQL (`holderAnswersSheetSql`)
 * adjudicates from the sources it reads like a lookup
 * (`SQL_READ_SHEET_SOURCES`) and leaves docket spellings, which only a
 * jurisdiction's grammar reads, to the lookup (`resolveDecisionIdentity`,
 * over the rows `readDecisionIdentityHits` returns as the public reader).
 *
 * Decisions are written with sheets in random sources, of this file and of
 * another, in every dash style, letter case, separator, prefix and storage,
 * and the set of decisions the SQL admits for a printed sheet must be the
 * set a lookup reading the same sources says carries it. A sheet stored
 * where the public reader cannot see it (the `sheet_number` column) is
 * admitted by neither, and one known only from a docket spelling is seen by
 * the lookup alone. A recorded sheet is written as an adapter writes it,
 * split off the decision's reference with the remaining docket stored, so
 * one recorded off another file's reference is admitted by neither, though
 * the decision is a candidate of the cited file by a case-number identifier.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import {
  DECISION_SHEET_SOURCES,
  parseDecisionQuery,
  resolveDecisionIdentity,
} from "@stll/api-contract/decision-query-intent";
import type { DecisionSheetSource } from "@stll/api-contract/decision-query-intent";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { stripUnicodeMarks } from "@stll/text-normalize";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { splitCaseReference } from "@/api/handlers/case-law/case-number";
import {
  holderAnswersSheetSql,
  SQL_READ_SHEET_SOURCES,
} from "@/api/handlers/case-law/citation-resolution";
import { readDecisionIdentityHits } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import {
  bareCitationKey,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { decisionDocketColumns } from "@/api/handlers/case-law/ingestion/pipeline/decision-docket-columns";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { DEFAULT_PRIMARY_REFERENCE_TYPE } from "@/api/lib/legal-search/decision-primary-reference";
import { storedCaseNumberOf } from "@/api/lib/legal-search/ingestion-normalization";
import { isRecord } from "@/api/lib/type-guards";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * Files whose dockets and ECLIs the decisions are spelled from: senate forms,
 * whose registry mark the grammar reads in any case, and letter-first ones,
 * which it reads only in title case.
 */
const FILES = [
  "8 As 287/2020",
  "65 A 3/2025",
  "1 Az 4/2026",
  "II. ÚS 55/98",
  "Nad 224/2014",
  "Konf 4/2011",
] as const;

/**
 * How a docket's file is spelled: as the court writes it, in another letter
 * case, with the slash as a space, or with its spaces as dashes.
 */
const DOCKET_FORMS = [
  "as-written",
  "lowercase",
  "uppercase",
  "slash-as-space",
  "dash-joined",
] as const;

type DocketForm = (typeof DOCKET_FORMS)[number];

/** The sheet a value carries: the printed one, or another number. */
type SheetPick = { kind: "cited" } | { kind: "other"; value: number };

type DocketSpelling = {
  /** This file, or the next one in `FILES`. */
  file: "own" | "other";
  form: DocketForm;
  /** A citation label before the docket. */
  prefix: "" | "č. j. ";
  tail:
    | { kind: "none" }
    | { kind: "part" }
    | { kind: "sheet"; sheet: SheetPick; dash: string; zero: boolean };
  /** Punctuation a publisher leaves after the reference. */
  trailing: "" | ".";
};

type EcliSpelling = {
  scheme: "CZ:NSS" | "CZ:NS";
  file: "own" | "other";
  /** A sheet after the file's numbers, or an ordinal ending on its year. */
  sheet: SheetPick | { kind: "none" };
};

type RecordedSheet = {
  value: SheetPick | { kind: "junk" };
  zero: boolean;
  padded: boolean;
  storage: "column" | "metadata" | "both";
};

type DecisionSpec = {
  caseNumber: DocketSpelling;
  published: DocketSpelling | null;
  caseNumberIdentifiers: DocketSpelling[];
  recorded: RecordedSheet | null;
  ecli: EcliSpelling | null;
  ecliIdentifiers: EcliSpelling[];
};

type Scenario = {
  /** The cited file's index in `FILES`. */
  file: number;
  cited: { value: number; zero: boolean };
  decisions: DecisionSpec[];
};

const sheetPickArb: fc.Arbitrary<SheetPick> = fc.oneof(
  fc.constant({ kind: "cited" } as const),
  fc
    .integer({ min: 1, max: 9999 })
    .map((value) => ({ kind: "other", value }) as const),
);

const sheetTailArb = fc.record({
  kind: fc.constant("sheet" as const),
  sheet: sheetPickArb,
  dash: fc.constantFrom("-", " - ", "– ", " – ", "—", " ‐ "),
  zero: fc.boolean(),
});

const docketSpellingArb: fc.Arbitrary<DocketSpelling> = fc.record({
  file: fc.constantFrom("own", "other"),
  form: fc.constantFrom(...DOCKET_FORMS),
  prefix: fc.constantFrom("", "č. j. "),
  trailing: fc.constantFrom("", "."),
  tail: fc.oneof(
    fc.constant({ kind: "none" } as const),
    fc.constant({ kind: "part" } as const),
    sheetTailArb,
  ),
});

/**
 * A reference an adapter splits a sheet off (`splitCaseReference`): a docket
 * dated after a slash, then the sheet, then nothing.
 */
const splitReferenceArb: fc.Arbitrary<DocketSpelling> = fc.record({
  file: fc.constantFrom("own", "other"),
  form: fc.constantFrom("as-written", "lowercase", "uppercase"),
  prefix: fc.constantFrom("", "č. j. "),
  trailing: fc.constant(""),
  tail: sheetTailArb,
});

const ecliSpellingArb: fc.Arbitrary<EcliSpelling> = fc.record({
  scheme: fc.constantFrom("CZ:NSS", "CZ:NS"),
  file: fc.constantFrom("own", "other"),
  sheet: fc.oneof(sheetPickArb, fc.constant({ kind: "none" } as const)),
});

const recordedSheetArb: fc.Arbitrary<RecordedSheet> = fc.record({
  value: fc.oneof(sheetPickArb, fc.constant({ kind: "junk" } as const)),
  zero: fc.boolean(),
  padded: fc.boolean(),
  storage: fc.constantFrom("column", "metadata", "both"),
});

const decisionSpecArb: fc.Arbitrary<DecisionSpec> = fc.oneof(
  fc.record({
    caseNumber: docketSpellingArb,
    published: fc.option(docketSpellingArb, { nil: null }),
    caseNumberIdentifiers: fc.array(docketSpellingArb, { maxLength: 2 }),
    recorded: fc.constant(null),
    ecli: fc.option(ecliSpellingArb, { nil: null }),
    ecliIdentifiers: fc.array(ecliSpellingArb, { maxLength: 1 }),
  }),
  // A sheet is recorded only off a reference it was split from: the one the
  // court published, or the stored docket where none was kept.
  fc.record({
    caseNumber: splitReferenceArb,
    published: fc.option(splitReferenceArb, { nil: null }),
    caseNumberIdentifiers: fc.array(docketSpellingArb, { maxLength: 2 }),
    recorded: recordedSheetArb,
    ecli: fc.option(ecliSpellingArb, { nil: null }),
    ecliIdentifiers: fc.array(ecliSpellingArb, { maxLength: 1 }),
  }),
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  file: fc.nat({ max: FILES.length - 1 }),
  // The extractor reads at most four digits after the docket.
  cited: fc.record({
    value: fc.integer({ min: 1, max: 999 }),
    zero: fc.boolean(),
  }),
  decisions: fc.array(decisionSpecArb, { minLength: 1, maxLength: 4 }),
});

const fileOf = (scenario: Scenario, which: "own" | "other"): string =>
  FILES[(scenario.file + (which === "own" ? 0 : 1)) % FILES.length] ??
  panic("FILES is indexed modulo its length");

const sheetValueOf = (scenario: Scenario, pick: SheetPick): number =>
  pick.kind === "cited" ? scenario.cited.value : pick.value;

const formedDocketOf = (file: string, form: DocketForm): string => {
  switch (form) {
    case "as-written":
      return file;
    case "lowercase":
      return file.toLowerCase();
    case "uppercase":
      return file.toUpperCase();
    case "slash-as-space":
      return file.replace("/", " ");
    case "dash-joined":
      return file.replaceAll(" ", "-");
    default: {
      form satisfies never;
      return panic("Unhandled docket form");
    }
  }
};

const docketTailOf = (scenario: Scenario, spelling: DocketSpelling): string => {
  switch (spelling.tail.kind) {
    case "none":
      return "";
    case "part":
      return " - II.";
    case "sheet": {
      const { dash, sheet, zero } = spelling.tail;
      return `${dash}${zero ? "0" : ""}${String(sheetValueOf(scenario, sheet))}`;
    }
    default: {
      spelling.tail satisfies never;
      return panic("Unhandled docket tail");
    }
  }
};

const docketOf = (scenario: Scenario, spelling: DocketSpelling): string => {
  const docket = formedDocketOf(fileOf(scenario, spelling.file), spelling.form);
  return `${spelling.prefix}${docket}${docketTailOf(scenario, spelling)}${spelling.trailing}`;
};

/** The ECLI ordinal a court of the scheme gives a file's document. */
const ecliOrdinalOf = (docket: string): string =>
  stripUnicodeMarks(docket, { form: "NFKD", markClass: "combining" })
    .split(/[^\p{L}\p{N}]+/u)
    .filter((segment) => segment.length > 0)
    .join(".");

const ecliOf = (scenario: Scenario, spelling: EcliSpelling): string => {
  const ordinal = ecliOrdinalOf(fileOf(scenario, spelling.file));
  const sheet =
    spelling.sheet.kind === "none"
      ? ""
      : `.${String(sheetValueOf(scenario, spelling.sheet))}`;
  return `ECLI:${spelling.scheme}:2021:${ordinal}${sheet}`;
};

const recordedValueOf = (
  scenario: Scenario,
  { padded, value, zero }: RecordedSheet,
): string => {
  const digits =
    value.kind === "junk"
      ? "n/a"
      : `${zero ? "0" : ""}${String(sheetValueOf(scenario, value))}`;
  return padded ? ` ${digits} ` : digits;
};

type IdentifierRow = {
  type: DecisionIdentifierType;
  value: string;
  normalizedValue: string;
};

type WrittenDecision = {
  id: SafeId<"caseLawDecision">;
  row: typeof caseLawDecisions.$inferInsert;
  identifiers: IdentifierRow[];
};

const identifierRow = (
  type: DecisionIdentifierType,
  value: string,
): IdentifierRow => ({
  type,
  value,
  normalizedValue: normalizeDecisionIdentifierValue(type, value),
});

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const sourceId = createSafeId<"caseLawSource">();

const writtenDecisionOf = (
  scenario: Scenario,
  spec: DecisionSpec,
): WrittenDecision => {
  const id = createSafeId<"caseLawDecision">();
  const published =
    spec.published === null ? null : docketOf(scenario, spec.published);
  // The docket an adapter stores beside a recorded sheet is what remains of
  // the reference it split the sheet off, so the two name one file.
  const caseNumber =
    spec.recorded === null
      ? docketOf(scenario, spec.caseNumber)
      : storedCaseNumberOf({
          caseNumber: splitCaseReference(
            published ?? docketOf(scenario, spec.caseNumber),
          ).caseNumber,
          country: "CZE",
          sourceDocumentId: id,
        });
  const recorded =
    spec.recorded === null ? null : recordedValueOf(scenario, spec.recorded);
  const storage = spec.recorded?.storage;
  const ecli = spec.ecli === null ? null : ecliOf(scenario, spec.ecli);
  // Every decision holds the file's bare docket, as a candidate of a citation
  // of the file does; its other spellings are what the property varies.
  const identifiers = new Map<string, IdentifierRow>();
  for (const row of [
    identifierRow(
      DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      fileOf(scenario, "own"),
    ),
    ...spec.caseNumberIdentifiers.map((spelling) =>
      identifierRow(
        DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        docketOf(scenario, spelling),
      ),
    ),
    ...spec.ecliIdentifiers.map((spelling) =>
      identifierRow(DECISION_IDENTIFIER_TYPES.ECLI, ecliOf(scenario, spelling)),
    ),
  ]) {
    // One row per normalized value, as the table's key allows; the first
    // kept, so the file's bare docket is never displaced by a spelling that
    // normalizes alike.
    const key = JSON.stringify([row.type, row.normalizedValue]);
    if (!identifiers.has(key)) {
      identifiers.set(key, row);
    }
  }
  const metadata = {
    ...(published === null ? {} : { publishedCaseNumber: published }),
    ...(recorded !== null && storage !== "column"
      ? { sheetNumber: recorded }
      : {}),
  };
  return {
    id,
    row: {
      id,
      sourceId,
      sourceDocumentId: id,
      slug: id,
      ...decisionDocketColumns({
        caseNumber,
        caseNumberType: DEFAULT_PRIMARY_REFERENCE_TYPE,
        country: "CZE",
      }),
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      fulltext: "text",
      ecli,
      sheetNumber:
        recorded !== null && storage !== "metadata" ? recorded : null,
      metadata,
    },
    identifiers: [...identifiers.values()],
  };
};

/** The decisions the resolver's SQL admits as carrying the printed sheet. */
const admittedBySql = async (
  scenario: Scenario,
  written: readonly WrittenDecision[],
): Promise<string[]> => {
  const cited = citedSheetOf(scenario);
  const result = await db.execute(sql`
    SELECT d.id::text AS id
      FROM ${caseLawDecisions} d
     WHERE d.id IN (${sql.join(
       written.map(({ id }) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND ${holderAnswersSheetSql({
         holder: sql.raw("d"),
         sheetNumber: sql`${cited}::varchar`,
         familyKey: sql`${bareCitationKey(fileOf(scenario, "own"))}::varchar`,
       })}
  `);
  return result.rows.map((row) =>
    isRecord(row) && typeof row["id"] === "string"
      ? row["id"]
      : panic("expected an id row"),
  );
};

const citedSheetOf = ({ cited }: Scenario): string =>
  `${cited.zero ? "0" : ""}${String(cited.value)}`;

/** The decisions as a lookup reads them: as the public reader, in production's read. */
const readAsLookup = async (written: readonly WrittenDecision[]) =>
  await withPublicLawReaderRole(db, async (roleTx) => {
    // SAFETY: the role transaction supplies the select surface the read uses.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
    const tx = roleTx as unknown as CaseLawPublicReadTransaction;
    return await readDecisionIdentityHits(
      tx,
      written.map(({ id }) => id),
    );
  });

/**
 * The decisions a lookup of the printed reference says carry its sheet, read
 * from `sheetSources` (every source when absent).
 */
const carriedByLookup = async (
  scenario: Scenario,
  written: readonly WrittenDecision[],
  sheetSources?: ReadonlySet<DecisionSheetSource>,
): Promise<string[]> => {
  const intent = parseDecisionQuery(
    `${fileOf(scenario, "own")}-${citedSheetOf(scenario)}`,
    { grammar: DECISION_DOCKET_GRAMMARS.CZE },
  );
  if (
    intent.type !== "identifier" ||
    intent.kind !== "docket" ||
    intent.selector.kind !== "sheet"
  ) {
    return panic(`the printed reference must read as a sheet of its file`);
  }
  const hits = await readAsLookup(written);
  if (hits.length !== written.length) {
    return panic("the public reader must see every written decision");
  }
  const resolution = resolveDecisionIdentity(intent, hits, { sheetSources });
  switch (resolution.status) {
    // Every written decision holds the file's docket, so nothing answers
    // only where each is known under another sheet: none carries this one.
    case "none":
      return [];
    case "unique":
      return [resolution.decision.id];
    case "ambiguous":
      return resolution.reason === "selector_unmatched"
        ? []
        : resolution.candidates.map(({ id }) => id);
    case "incomplete_identifier":
      return resolution.candidates.map(({ id }) => id);
    default: {
      resolution satisfies never;
      return panic("Unhandled identity resolution");
    }
  }
};

const writeScenario = async (
  scenario: Scenario,
  specs: readonly DecisionSpec[],
): Promise<WrittenDecision[]> => {
  const written = specs.map((spec) => writtenDecisionOf(scenario, spec));
  await db.insert(caseLawDecisions).values(written.map(({ row }) => row));
  await db.insert(caseLawDecisionIdentifiers).values(
    written.flatMap(({ id, identifiers }) =>
      identifiers.map((identifier) => ({
        ...identifier,
        decisionId: id,
      })),
    ),
  );
  return written;
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "citation-sheet-sources",
    name: "citation sheet sources",
  });
}, 120_000);

afterAll(async () => {
  await client.close();
});

const BARE: DocketSpelling = {
  file: "own",
  form: "as-written",
  prefix: "",
  tail: { kind: "none" },
  trailing: "",
};
const CITED: SheetPick = { kind: "cited" };
const NOTHING_ELSE: DecisionSpec = {
  caseNumber: BARE,
  published: null,
  caseNumberIdentifiers: [],
  recorded: null,
  ecli: null,
  ecliIdentifiers: [],
};
const CITED_DOCKET: DocketSpelling = {
  ...BARE,
  tail: { kind: "sheet", sheet: CITED, dash: " - ", zero: false },
};
const CITED_ECLI: EcliSpelling = {
  scheme: "CZ:NSS",
  file: "own",
  sheet: CITED,
};

/**
 * One decision per source carrying the printed sheet there and nowhere else.
 * Total over the sources, so a source added to the list needs a case here.
 */
const SINGLE_SOURCE_DECISIONS = {
  "case-number": { ...NOTHING_ELSE, caseNumber: CITED_DOCKET },
  "published-case-number": { ...NOTHING_ELSE, published: CITED_DOCKET },
  "case-number-identifier": {
    ...NOTHING_ELSE,
    caseNumberIdentifiers: [CITED_DOCKET],
  },
  "recorded-sheet": {
    ...NOTHING_ELSE,
    recorded: { value: CITED, zero: false, padded: false, storage: "metadata" },
  },
  ecli: { ...NOTHING_ELSE, ecli: CITED_ECLI },
  "ecli-identifier": { ...NOTHING_ELSE, ecliIdentifiers: [CITED_ECLI] },
} as const satisfies Record<DecisionSheetSource, DecisionSpec>;

describe("a decision's sheet from any source", () => {
  test("a lookup sees each source alone carry the printed sheet, and SQL each source it reads", async () => {
    const scenario: Scenario = {
      file: 0,
      cited: { value: 33, zero: false },
      decisions: [],
    };
    for (const { source } of DECISION_SHEET_SOURCES) {
      // A sibling that carries nothing, so a lone decision is not answered
      // by the file alone.
      const written = await writeScenario(scenario, [
        SINGLE_SOURCE_DECISIONS[source],
        NOTHING_ELSE,
      ]);
      const carrier =
        written.at(0)?.id ?? panic(`no decision written for ${source}`);
      // A docket-sourced sheet is the lookup's alone: SQL leaves it unread
      // rather than read it unlike the grammar does.
      const readInSql = SQL_READ_SHEET_SOURCES.has(source);
      expect({
        source,
        admitted: await admittedBySql(scenario, written),
        carried: await carriedByLookup(scenario, written),
      }).toEqual({
        source,
        admitted: readInSql ? [carrier] : [],
        carried: [carrier],
      });
    }
  });

  test("a sheet recorded off another file's reference is carried by neither", async () => {
    const scenario: Scenario = {
      file: 0,
      cited: { value: 33, zero: false },
      decisions: [],
    };
    const otherFileSheet: DocketSpelling = { ...CITED_DOCKET, file: "other" };
    const recorded: RecordedSheet = {
      value: CITED,
      zero: false,
      padded: false,
      storage: "metadata",
    };
    // Split off the reference the court published, or off the stored docket
    // where none was kept; either way the decision reaches the cited file
    // only through the bare docket every decision holds as an identifier.
    for (const spec of [
      { ...NOTHING_ELSE, published: otherFileSheet, recorded },
      { ...NOTHING_ELSE, caseNumber: otherFileSheet, recorded },
    ]) {
      const written = await writeScenario(scenario, [spec, NOTHING_ELSE]);
      expect({
        admitted: await admittedBySql(scenario, written),
        carried: await carriedByLookup(scenario, written),
      }).toEqual({ admitted: [], carried: [] });
    }
  });

  test(
    "the resolver's SQL admits exactly the decisions a lookup of the sources it reads says carry the printed sheet",
    async () => {
      await assertProperty(
        "the resolver's SQL admits exactly the decisions a lookup of the sources it reads says carry the printed sheet",
        fc.asyncProperty(scenarioArb, async (scenario) => {
          const written = await writeScenario(scenario, scenario.decisions);
          const admitted = await admittedBySql(scenario, written);
          const carried = await carriedByLookup(
            scenario,
            written,
            SQL_READ_SHEET_SOURCES,
          );
          expect(admitted.toSorted()).toEqual(carried.toSorted());
          // Reading fewer sources only ever leaves a carrier unseen.
          const carriedByAny = await carriedByLookup(scenario, written);
          expect(admitted.filter((id) => !carriedByAny.includes(id))).toEqual(
            [],
          );
        }),
        { numRuns: 150 },
      );
    },
    propertyTestTimeout(60_000),
  );
});
