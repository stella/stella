import { panic } from "better-result";

import {
  DECISION_DOCKET_GRAMMARS,
  DECISION_IDENTIFIER_WHITESPACE,
} from "./decision-docket-grammar";
import type {
  DecisionDocketFilingYear,
  DecisionDocketJurisdiction,
} from "./decision-docket-grammar";
import { DECISION_DOCKET_GRAMMAR_FIXTURES } from "./decision-docket-grammar.fixtures";

type FilingYearFixture = {
  readonly jurisdiction: DecisionDocketJurisdiction;
  readonly caseNumber: string;
  readonly expected: DecisionDocketFilingYear;
};

const none = { type: "none-in-format" } as const;
const unparseable = { type: "unparseable" } as const;

const filingYearCases = {
  AUT: [{ caseNumber: "2 Ob 42/24a", expected: none }],
  BRA: [
    {
      caseNumber: "0000751-20.2099.5.08.0017",
      expected: { type: "known", year: 2099 },
    },
    {
      caseNumber: "00007512020995080017",
      expected: { type: "known", year: 2099 },
    },
    {
      caseNumber: "Ag-AIRR - 751-20.2099.5.08.0017",
      expected: { type: "known", year: 2099 },
    },
    { caseNumber: "RE 99.234.567/SP", expected: none },
    { caseNumber: "EDcl no AgInt no REsp 99810170", expected: none },
    { caseNumber: "ADI 99341 MC-Ref", expected: none },
    { caseNumber: "0000751-20.0000.5.08.0017", expected: unparseable },
    { caseNumber: "unparsed", expected: unparseable },
    { caseNumber: "", expected: unparseable },
  ],
  CZE: [
    { caseNumber: "7 Co 91/2022", expected: { type: "known", year: 2022 } },
    { caseNumber: "23 C 57/2020", expected: { type: "known", year: 2020 } },
    { caseNumber: "6 As 83/2019", expected: { type: "known", year: 2019 } },
    { caseNumber: "II. ÚS 72/2021", expected: { type: "known", year: 2021 } },
    { caseNumber: "Nad 72/2021", expected: { type: "known", year: 2021 } },
    { caseNumber: "7 Co 91/22", expected: unparseable },
    { caseNumber: "MZDR 91/2022", expected: unparseable },
    { caseNumber: "7 Co 91/0000", expected: unparseable },
    { caseNumber: "2022", expected: unparseable },
    { caseNumber: "No. 42", expected: unparseable },
    { caseNumber: "", expected: unparseable },
  ],
  EU: [{ caseNumber: "C-42/24", expected: none }],
  GBR: [{ caseNumber: "[2024] UKSC 42", expected: none }],
  HUN: [{ caseNumber: "Pfv.IV.20.042/2024/2", expected: none }],
  POL: [{ caseNumber: "II CSK 42/24", expected: none }],
  SVK: [
    { caseNumber: "7Co/91/2022", expected: { type: "known", year: 2022 } },
    { caseNumber: "7 Co 91/2022", expected: { type: "known", year: 2022 } },
    { caseNumber: "II.ÚS/72/2021", expected: { type: "known", year: 2021 } },
    { caseNumber: "II. ÚS 72/98", expected: unparseable },
    { caseNumber: "7Co/91/0000", expected: unparseable },
    { caseNumber: "No. 42", expected: unparseable },
    { caseNumber: "", expected: unparseable },
  ],
  USA: [{ caseNumber: "No. 42", expected: none }],
} as const satisfies Record<
  DecisionDocketJurisdiction,
  readonly Omit<FilingYearFixture, "jurisdiction">[]
>;

/** One corpus for the TypeScript owner and the migrated PostgreSQL function. */
export const DECISION_DOCKET_FILING_YEAR_FIXTURES: readonly FilingYearFixture[] =
  [
    ...Object.values(DECISION_DOCKET_GRAMMARS).flatMap(({ jurisdiction }) =>
      filingYearCases[jurisdiction].map((fixture) => ({
        ...fixture,
        jurisdiction,
      })),
    ),
    ...(["CZE", "SVK", "BRA"] as const).flatMap((jurisdiction) =>
      [1, 999, 1000, 1800, 1999, 2026, 9999].flatMap((year) => {
        const digits = String(year).padStart(4, "0");
        const base = {
          CZE: `7 Co 91/${digits}`,
          SVK: `7Co/91/${digits}`,
          BRA: `0000751-20.${digits}.5.08.0017`,
        }[jurisdiction];
        const expected = { type: "known", year } as const;
        return [
          { jurisdiction, caseNumber: base, expected },
          ...Array.from(DECISION_IDENTIFIER_WHITESPACE, (space) => ({
            jurisdiction,
            caseNumber: `${space}${base.replace("Co", "Čo").replaceAll(" ", () => space)}${space}`,
            expected,
          })),
          ...["-", "‐", "‑", "‒", "–", "—", "―", "−"].map((dash) => ({
            jurisdiction,
            caseNumber: ` \t${base}${dash}31\u00a0`,
            expected,
          })),
          {
            jurisdiction,
            caseNumber: base
              .replace(/[0-9]/gu, (digit) =>
                String.fromCodePoint(
                  (digit.codePointAt(0) ?? panic("Missing docket digit")) +
                    65_248,
                ),
              )
              .replaceAll(" ", "\u202f"),
            expected,
          },
          // Arabic-Indic and Devanagari digits do not fold to ASCII.
          ...[1632, 2406].map((zero) => ({
            jurisdiction,
            caseNumber: base.replace(/[0-9]/gu, (digit) =>
              String.fromCodePoint(zero + Number(digit)),
            ),
            expected: unparseable,
          })),
          { jurisdiction, caseNumber: `${base} extra`, expected: unparseable },
        ];
      }),
    ),
    ...Object.values(DECISION_DOCKET_GRAMMARS).flatMap(
      ({ jurisdiction, filingYearRule }) =>
        DECISION_DOCKET_GRAMMAR_FIXTURES[jurisdiction].flatMap(
          ({ variants }) =>
            filingYearRule.type === "formats"
              ? []
              : variants.map((caseNumber) => ({
                  jurisdiction,
                  caseNumber,
                  expected: none,
                })),
        ),
    ),
  ];
