import fc from "fast-check";

import {
  DECISION_DOCKET_GRAMMARS,
  type DecisionDocketJurisdiction,
} from "./decision-docket-grammar";

/** A scenario a jurisdiction's grammar cannot express, and why. */
type UnsupportedDocketScenario = {
  readonly type: "unsupported";
  readonly reason: string;
};

/**
 * A sheet number printed after the docket, which the grammar keys away from
 * its file: `held` is the sheet a sibling is stored under, `unheld` one no
 * decision carries and whose digits end `held`, so a suffix match would take
 * it for `held`.
 */
type DocketSheetScenario =
  | {
      readonly type: "supported";
      readonly held: string;
      readonly unheld: string;
    }
  | UnsupportedDocketScenario;

type DocketIdentityFixture = {
  /**
   * A case file's docket as its court files it, numbered `n` (1 to
   * `DOCKET_IDENTITY_FIXTURE_NUMBER_MAX`) so a run on a shared database
   * reads only its own rows.
   */
  readonly filed: (n: number) => string;
  /** Other spellings of the same file a reader types: case, gaps, a lead. */
  readonly readerSpellings: (n: number) => readonly string[];
  readonly sheet: DocketSheetScenario;
  /** Generated dockets of every form the grammar reads, for properties. */
  readonly generated: GeneratedDockets;
};

/**
 * Whether a stored sibling of the file, carrying a part after its docket
 * (`<filed> - II.`), is read under the keys a reader's entry with that part
 * yields. A stored docket with a tail is keyed by its own spelling, so only
 * a family spelled as the stored docket reaches it; a reader spelling the
 * court's docket differently is declared, with why.
 */
type PartSiblingKey =
  | { readonly type: "keyed" }
  | { readonly type: "apart"; readonly reason: string };

const KEYED: PartSiblingKey = { type: "keyed" };

/**
 * A docket in its court's spelling (`filed`, as ingestion stores it) and one
 * spelling a reader writes it in (`written`): compact, without a thousands
 * dot, without or with a lead the grammar keeps out of the docket.
 */
type GeneratedDocket = {
  readonly filed: string;
  readonly written: string;
  readonly partSibling: PartSiblingKey;
};

type GeneratedDockets = {
  readonly dockets: fc.Arbitrary<GeneratedDocket>;
  /** Words a reader may put before `written`, the empty one included. */
  readonly leads: readonly [string, ...string[]];
};

const ROMAN_NUMERALS = [
  "I",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
  "XI",
  "XIV",
  "XIX",
  "XXIII",
  "XXV",
] as const;

/**
 * A Hungarian register number written without its thousands dot. The stored
 * key of a docket with a part after it is its own spelling, and the courts'
 * printed docket and the publisher's listing differ on the dot, so no single
 * family reaches both; the key function does not read a part tail apart.
 */
const HUNGARIAN_UNDOTTED_PART_SIBLING: PartSiblingKey = {
  type: "apart",
  reason:
    "A stored docket with a part keys by its spelling, and the register number's thousands dot differs between print and listing.",
};

const twoDigits = fc
  .integer({ min: 0, max: 99 })
  .map((value) => String(value).padStart(2, "0"));
const ordinal = (max: number) => fc.integer({ min: 1, max }).map(String);
const year = fc.integer({ min: 1993, max: 2099 }).map(String);

/** `filed` as written, or with each space between letters and digits dropped. */
const compactedOrNot = (filed: string) =>
  fc.constantFrom(
    filed,
    filed.replace(/(?<=\p{L}) (?=\d)|(?<=\d) (?=\p{L})/gu, ""),
  );

const withWritten = (
  filed: fc.Arbitrary<string>,
  written: (filed: string) => fc.Arbitrary<string> = fc.constant,
): fc.Arbitrary<GeneratedDocket> =>
  filed.chain((docket) =>
    written(docket).map((spelling) => ({
      filed: docket,
      written: spelling,
      partSibling: KEYED,
    })),
  );

/** The largest `n` every fixture docket accepts, with `n + 1` for a second file. */
export const DOCKET_IDENTITY_FIXTURE_NUMBER_MAX = 998;

/**
 * The Roman part numeral a publisher leaves on a sibling's stored docket
 * (`6 Tdo 1/2021 - II.`), as every grammar's tail reading accepts it.
 */
export const DOCKET_IDENTITY_PART_NUMERAL = "II";

/**
 * Synthetic dockets for every declared grammar, for the identity checks that
 * run per jurisdiction: a file, the spellings a reader types for it, and the
 * sheet its siblings are told apart by where the grammar has one. Years are
 * far from any real filing.
 */
export const DECISION_DOCKET_IDENTITY_FIXTURES = {
  AUT: {
    filed: (n) => `W ${String(n)}/2099`,
    readerSpellings: (n) => [
      `w${String(n)}/2099`,
      `w ${String(n)}/2099`,
      `W ${String(n)} / 2099`,
    ],
    sheet: { type: "supported", held: "33", unheld: "3" },
    generated: {
      dockets: fc.oneof(
        withWritten(
          fc
            .tuple(
              ordinal(99),
              fc.constantFrom("Ob", "Os", "ObA", "Nc", "Fsc"),
              ordinal(9999),
              twoDigits,
              fc.constantFrom("a", "k", "x", "y"),
            )
            .map(
              ([senate, registry, number, yy, letter]) =>
                `${senate} ${registry} ${number}/${yy}${letter}`,
            ),
          compactedOrNot,
        ),
        withWritten(
          fc
            .tuple(
              fc.constantFrom("Ra", "Ro", "Rw"),
              year,
              twoDigits,
              fc.integer({ min: 1, max: 9999 }),
            )
            .map(
              ([registry, filingYear, register, number]) =>
                `${registry} ${filingYear}/${register}/${String(number).padStart(4, "0")}`,
            ),
          compactedOrNot,
        ),
        withWritten(
          fc
            .tuple(fc.constantFrom("W", "G", "E", "V"), ordinal(9999), year)
            .map(
              ([registry, number, filingYear]) =>
                `${registry} ${number}/${filingYear}`,
            ),
          compactedOrNot,
        ),
      ),
      leads: [""],
    },
  },
  CZE: {
    filed: (n) => `3 Afs ${String(n)}/2099`,
    readerSpellings: (n) => [
      `sp. zn. 3 Afs ${String(n)}/2099`,
      `3Afs${String(n)}/2099`,
      `3 afs ${String(n)} / 2099`,
    ],
    sheet: { type: "supported", held: "33", unheld: "3" },
    generated: {
      dockets: fc.oneof(
        withWritten(
          fc
            .tuple(
              ordinal(99),
              fc.constantFrom(
                "Cdo",
                "Tdo",
                "Afs",
                "As",
                "Azs",
                "NSČR",
                "Cmo",
                "A",
              ),
              ordinal(99_999),
              year,
            )
            .map(
              ([senate, registry, number, filingYear]) =>
                `${senate} ${registry} ${number}/${filingYear}`,
            ),
          compactedOrNot,
        ),
        withWritten(
          fc
            .tuple(
              fc.constantFrom("I", "II", "III", "IV", "Pl"),
              ordinal(9999),
              fc.constantFrom("04", "98", "2019"),
            )
            .map(([senate, number, yy]) => `${senate}. ÚS ${number}/${yy}`),
        ),
      ),
      leads: ["", "sp. zn. ", "č. j. ", "sp.zn."],
    },
  },
  EU: {
    filed: (n) => `C-${String(n)}/99`,
    readerSpellings: (n) => [
      `case c-${String(n)}/99`,
      `C‑${String(n)}/99`,
      `Rechtssache C-${String(n)}/99`,
    ],
    sheet: {
      type: "unsupported",
      reason:
        "A case number has no sheet: a trailing `-digits` is not part of the grammar.",
    },
    generated: {
      dockets: withWritten(
        fc
          .tuple(
            fc.constantFrom("C", "T", "F"),
            ordinal(9999),
            twoDigits,
            fc.constantFrom("", " P"),
          )
          .map(
            ([court, number, yy, appeal]) =>
              `${court}-${number}/${yy}${appeal}`,
          ),
      ),
      leads: ["", "case ", "Case ", "Rechtssache ", "affaire ", "věc "],
    },
  },
  HUN: {
    filed: (n) => `Kfv.II.${String(n)}.500/2099/8`,
    readerSpellings: (n) => [
      `kfv.ii.${String(n)}.500/2099/8`,
      `KFV.II.${String(n)}.500/2099/8`,
      // The register number as databases print it, without the thousands dot.
      `Kfv.II.${String(n)}500/2099/8`,
    ],
    sheet: {
      type: "unsupported",
      reason:
        "The document number after the year (`/8`) is keyed as part of the docket; the grammar reads no sheet apart from its file.",
    },
    generated: {
      dockets: fc
        .tuple(
          fc.constantFrom("Pfv", "Kfv", "Gfv", "Bfv", "Mfv"),
          fc.constantFrom("", "I.", "II.", "IV.", "VI."),
          fc.integer({ min: 1000, max: 99_999 }),
          year,
          ordinal(99),
        )
        .chain(([registry, numeral, register, filingYear, document]) => {
          const digits = String(register);
          const dotted = `${digits.slice(0, -3)}.${digits.slice(-3)}`;
          return fc.constantFrom(dotted, digits).map((spelled) => ({
            filed: `${registry}.${numeral}${dotted}/${filingYear}/${document}`,
            written: `${registry}.${numeral}${spelled}/${filingYear}/${document}`,
            partSibling:
              spelled === dotted ? KEYED : HUNGARIAN_UNDOTTED_PART_SIBLING,
          }));
        }),
      leads: [""],
    },
  },
  POL: {
    filed: (n) => `II CSK ${String(n)}/99`,
    readerSpellings: (n) => [
      `ii csk ${String(n)}/99`,
      `sygn. akt II CSK ${String(n)}/99`,
      `II CSK ${String(n)} / 99`,
    ],
    sheet: {
      type: "unsupported",
      reason:
        "A sygnatura has no sheet: a trailing `-digits` is not part of the grammar.",
    },
    generated: {
      dockets: fc.oneof(
        withWritten(
          fc
            .tuple(
              fc.constantFrom(...ROMAN_NUMERALS),
              fc.constantFrom(
                "CSK",
                "CZP",
                "KK",
                "UK",
                "Gz",
                "Ca",
                "C",
                "P",
                "K",
                "A Ua",
                "AUa",
                "ACa",
              ),
              ordinal(99_999),
              twoDigits,
            )
            .map(
              ([chamber, division, number, yy]) =>
                `${chamber} ${division} ${number}/${yy}`,
            ),
        ),
        withWritten(
          fc
            .tuple(
              fc.constantFrom("I", "II", "III", "IV", "VI", "VIII"),
              fc.constantFrom("Wa", "Kr", "Gd", "Po", "Łd"),
              ordinal(99_999),
              twoDigits,
            )
            .map(
              ([division, seat, number, yy]) =>
                `${division} SA/${seat} ${number}/${yy}`,
            ),
        ),
        withWritten(
          fc
            .tuple(
              fc.constantFrom("I", "II", "III"),
              fc.constantFrom("FSK", "GSK", "OSK", "OZ"),
              ordinal(99_999),
              twoDigits,
            )
            .map(
              ([division, mark, number, yy]) =>
                `${division} ${mark} ${number}/${yy}`,
            ),
        ),
      ),
      leads: ["", "sygn. akt ", "sygn. ", "Sygn. akt: "],
    },
  },
  SVK: {
    filed: (n) => `5Obo/${String(n)}/2099`,
    readerSpellings: (n) => [
      `5 Obo ${String(n)}/2099`,
      `5obo/${String(n)}/2099`,
      `5 Obo/${String(n)}/2099`,
    ],
    sheet: { type: "supported", held: "33", unheld: "3" },
    generated: {
      dockets: fc.oneof(
        fc
          .tuple(
            ordinal(99),
            fc.constantFrom("Obo", "Cdo", "Sžf", "Tdo", "Obdo"),
            ordinal(99_999),
            year,
          )
          .chain(([senate, registry, number, filingYear]) =>
            fc
              .constantFrom(
                `${senate}${registry}/${number}/${filingYear}`,
                `${senate} ${registry} ${number}/${filingYear}`,
                `${senate} ${registry}/${number}/${filingYear}`,
              )
              .map((written) => ({
                filed: `${senate}${registry}/${number}/${filingYear}`,
                written,
                partSibling: KEYED,
              })),
          ),
        withWritten(
          fc
            .tuple(
              fc.constantFrom("I", "II", "III", "IV", "PL"),
              ordinal(9999),
              fc.constantFrom("98", "04", "2019"),
            )
            .map(([senate, number, yy]) => `${senate}. ÚS ${number}/${yy}`),
          (filed) => fc.constantFrom(filed, filed.replace(". ÚS ", ".ÚS ")),
        ),
      ),
      leads: ["", "č. k. ", "sp. zn. "],
    },
  },
  USA: {
    // The Court prints a docket behind its `No.`, and the published record
    // carries it so.
    filed: (n) => `No. 99-${String(n)}`,
    readerSpellings: (n) => [`99-${String(n)}`, `no.99‑${String(n)}`],
    sheet: {
      type: "unsupported",
      reason:
        "Every digit of a docket is the case (`21-123`, `21-456`); the grammar keys no trailing number away as a sheet.",
    },
    generated: {
      // The lead is part of `written`, since one form cannot drop it.
      dockets: fc.oneof(
        fc
          .tuple(twoDigits, ordinal(99_999), fc.constantFrom("-", "A"))
          .chain(([term, number, mark]) =>
            fc.constantFrom("", "No. ", "no.", "No ").map((lead) => ({
              filed: `No. ${term}${mark}${number}`,
              written: `${lead}${term}${mark}${number}`,
              partSibling: KEYED,
            })),
          ),
        // An original case is filed in print, whichever form a reader types.
        fc.tuple(twoDigits, ordinal(9999)).chain(([term, number]) =>
          fc
            .constantFrom(
              `No. ${number}, Orig.`,
              `${number}, Orig.`,
              `${number} orig`,
              `No. ${number} Original`,
              `${term}O${number}`,
              `No. ${term}O${number}`,
            )
            .map((written) => ({
              filed: `No. ${number}, Orig.`,
              written,
              partSibling: KEYED,
            })),
        ),
        ordinal(99_999).chain((number) =>
          fc
            .constantFrom(`No. ${number}`, `No ${number}`, `no.${number}`)
            .map((written) => ({
              filed: `No. ${number}`,
              written,
              partSibling: KEYED,
            })),
        ),
      ),
      leads: [""],
    },
  },
} as const satisfies Record<DecisionDocketJurisdiction, DocketIdentityFixture>;

const LETTER_CASES = [
  (text: string) => text,
  (text: string) => text.toLowerCase(),
  (text: string) => text.toUpperCase(),
] as const;

/**
 * A generated docket of `jurisdiction`, and an entry a reader types for it:
 * the written spelling behind one of the grammar's leads, in either letter
 * case, with or without gaps around its slashes and dashes, in any dash.
 */
const readerEntryOf = (
  jurisdiction: DecisionDocketJurisdiction,
): fc.Arbitrary<{
  readonly jurisdiction: DecisionDocketJurisdiction;
  readonly filed: string;
  readonly entry: string;
  readonly partSibling: PartSiblingKey;
}> => {
  const { dockets, leads } =
    DECISION_DOCKET_IDENTITY_FIXTURES[jurisdiction].generated;
  return fc
    .record({
      docket: dockets,
      lead: fc.constantFrom(...leads),
      letterCase: fc.constantFrom(...LETTER_CASES),
      gap: fc.constantFrom("", " "),
      dash: fc.constantFrom("-", "‑", "–"),
    })
    .map(({ dash, docket, gap, lead, letterCase }) => {
      const spaced = `${lead}${docket.written}`
        .replaceAll("/", () => `${gap}/${gap}`)
        .replaceAll("-", () => `${gap}${dash}${gap}`);
      return {
        jurisdiction,
        filed: docket.filed,
        entry: letterCase(spaced),
        partSibling: docket.partSibling,
      };
    });
};

/**
 * A reader entry for a generated docket of any grammar. A property id is its
 * test's literal title, so one property spans every grammar and its
 * counterexample names the jurisdiction.
 */
export const docketReaderEntryArbitrary = fc
  .constantFrom(
    ...Object.values(DECISION_DOCKET_GRAMMARS).map(
      ({ jurisdiction }) => jurisdiction,
    ),
  )
  .chain(readerEntryOf);
