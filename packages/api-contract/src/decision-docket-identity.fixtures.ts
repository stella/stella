import type { DecisionDocketJurisdiction } from "./decision-docket-grammar";

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
};

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
  },
  CZE: {
    filed: (n) => `3 Afs ${String(n)}/2099`,
    readerSpellings: (n) => [
      `sp. zn. 3 Afs ${String(n)}/2099`,
      `3Afs${String(n)}/2099`,
      `3 afs ${String(n)} / 2099`,
    ],
    sheet: { type: "supported", held: "33", unheld: "3" },
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
  },
  SVK: {
    filed: (n) => `5Obo/${String(n)}/2099`,
    readerSpellings: (n) => [
      `5 Obo ${String(n)}/2099`,
      `5obo/${String(n)}/2099`,
      `5 Obo/${String(n)}/2099`,
    ],
    sheet: { type: "supported", held: "33", unheld: "3" },
  },
  USA: {
    filed: (n) => `99-${String(n)}`,
    readerSpellings: (n) => [`No. 99-${String(n)}`, `no.99‑${String(n)}`],
    sheet: {
      type: "unsupported",
      reason:
        "Every digit of a docket is the case (`21-123`, `21-456`); the grammar keys no trailing number away as a sheet.",
    },
  },
} as const satisfies Record<DecisionDocketJurisdiction, DocketIdentityFixture>;
