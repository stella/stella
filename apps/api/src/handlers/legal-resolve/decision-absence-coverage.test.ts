import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";
import type { DecisionIdentifierIntent } from "@stll/api-contract/decision-query-intent";
import {
  ADAPTER_MANIFESTS,
  decisionDocketGrammarForCountry,
} from "@stll/case-law-ingestion-core/adapter-manifest";
import { plainTextIngestionResult } from "@stll/case-law-ingestion-core/plain-text-assembly";
import { assertProperty } from "@stll/property-testing";

import {
  type AbsenceCoverageSource,
  decisionAbsenceCoverage,
  decisionAbsenceHint,
  docketRegisterOf,
  EXCLUSIVE_DOCKET_REGISTERS,
  sourceAbsenceVerdict,
} from "@/api/handlers/legal-resolve/decision-absence-coverage";
import { CASE_LAW_CONFORMANCE_FIXTURES } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const testFetchState = createTestFetch();

const CZE = decisionDocketGrammarForCountry("CZE");

const docketIntent = (entry: string): DecisionIdentifierIntent => {
  const parsed = parseDecisionQuery(entry, { grammar: CZE });
  if (parsed.type !== "identifier") {
    throw new Error(`not a docket: ${entry}`);
  }
  return parsed;
};

const reconciled = (
  years: readonly { year: number; missing?: number }[],
): AbsenceCoverageSource["knownGaps"] => ({
  type: "reconciled",
  years: years.map(({ year, missing }) =>
    missing === undefined
      ? { year, type: "complete" as const }
      : { year, type: "gaps" as const, missing, shortSlices: 1 },
  ),
});

const yearsFrom = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => ({ year: from + index }));

const SUPREME: AbsenceCoverageSource = {
  adapterKey: "cz-ns",
  name: "Nejvyšší soud",
  decisionYearFrom: 1993,
  decisionYearTo: 2026,
  knownGaps: reconciled(
    yearsFrom(2010, 2026).map(({ year }) =>
      [2016, 2019, 2023].includes(year) ? { year, missing: 1 } : { year },
    ),
  ),
  courts: [{ court: "Nejvyšší soud" }],
};
const REGIONAL: AbsenceCoverageSource = {
  adapterKey: "cz-regional",
  name: "Okresní, krajské a vrchní soudy",
  decisionYearFrom: 2006,
  decisionYearTo: 2026,
  knownGaps: reconciled(yearsFrom(2020, 2026)),
  courts: [
    { court: "Vrchní soud v Olomouci" },
    { court: "Krajský soud v Brně" },
  ],
};
const CONSTITUTIONAL: AbsenceCoverageSource = {
  adapterKey: "cz-us",
  name: "Ústavní soud",
  decisionYearFrom: 1993,
  decisionYearTo: 2026,
  knownGaps: { type: "not_reconciled", reason: "not sliced" },
  courts: [{ court: "Ústavní soud" }],
};
const SNAPSHOT = {
  generatedAt: "2026-11-17T19:00:00.000Z",
  countries: [{ country: "CZE", sources: [SUPREME, REGIONAL, CONSTITUTIONAL] }],
};

describe("a source's verdict over the years a decision can carry", () => {
  test("legal-resolve.absence-verdict-matches-ledger", () => {
    assertProperty(
      "legal-resolve.absence-verdict-matches-ledger",
      fc.property(
        fc.integer({ min: 1990, max: 2026 }),
        fc.integer({ min: 0, max: 20 }),
        fc.uniqueArray(fc.integer({ min: 1990, max: 2046 }), {
          maxLength: 40,
        }),
        fc.uniqueArray(fc.integer({ min: 1990, max: 2046 }), {
          maxLength: 5,
        }),
        (from, span, ledgerYears, gapYears) => {
          const years = { from, to: from + span };
          const source: AbsenceCoverageSource = {
            ...SUPREME,
            knownGaps: reconciled(
              ledgerYears.map((year) =>
                gapYears.includes(year) ? { year, missing: 2 } : { year },
              ),
            ),
          };
          const verdict = sourceAbsenceVerdict(source, years);
          let everyYearComplete = true;
          for (let year = years.from; year <= years.to; year += 1) {
            everyYearComplete &&=
              ledgerYears.includes(year) && !gapYears.includes(year);
          }
          expect(verdict.verdict === "not_published").toBe(everyYearComplete);
          if (verdict.verdict === "incomplete") {
            // Every open year is named, once, as a gap or an unreconciled run.
            const named = [
              ...verdict.gapYears.map(({ year }) => year),
              ...verdict.unreconciledYears.flatMap(({ from: a, to: b }) =>
                Array.from({ length: b - a + 1 }, (_, index) => a + index),
              ),
            ].toSorted((left, right) => left - right);
            const open: number[] = [];
            for (let year = years.from; year <= years.to; year += 1) {
              if (!ledgerYears.includes(year) || gapYears.includes(year)) {
                open.push(year);
              }
            }
            expect(named).toEqual(open);
          }
        },
      ),
    );
  });

  test("passes an unreconciled listing through with its reason", () => {
    expect(
      sourceAbsenceVerdict(CONSTITUTIONAL, { from: 2020, to: 2026 }),
    ).toEqual({
      verdict: "not_reconciled",
      source: "cz-us",
      sourceName: "Ústavní soud",
      reason: "not sliced",
    });
  });
});

describe("the absence of a cited decision", () => {
  test("at a named court whose listing is complete is not published", () => {
    const coverage = decisionAbsenceCoverage({
      snapshot: SNAPSHOT,
      country: "CZE",
      intent: docketIntent("5 Cmo 174/2025"),
      grammar: CZE,
      namedCourts: ["Vrchní soud v Olomouci"],
    });
    expect(coverage.sources).toEqual([
      {
        verdict: "not_published",
        source: "cz-regional",
        sourceName: "Okresní, krajské a vrchní soudy",
        years: { from: 2025, to: 2026 },
      },
    ]);
    expect(decisionAbsenceHint(coverage)).toContain("Do not scan");
  });

  test("under a register one court keeps names that court's open years", () => {
    const coverage = decisionAbsenceCoverage({
      snapshot: SNAPSHOT,
      country: "CZE",
      intent: docketIntent("29 Cdo 4084/2009"),
      grammar: CZE,
      namedCourts: [],
    });
    expect(coverage.sources).toEqual([
      {
        verdict: "incomplete",
        source: "cz-ns",
        sourceName: "Nejvyšší soud",
        years: { from: 2009, to: 2026 },
        gapYears: [
          { year: 2016, missing: 1 },
          { year: 2019, missing: 1 },
          { year: 2023, missing: 1 },
        ],
        unreconciledYears: [{ from: 2009, to: 2009 }],
      },
    ]);
    expect(decisionAbsenceHint(coverage)).toBe(
      "coverage: stella may lack it only in cz-ns 2016, 2019, 2023, 2009; elsewhere the publisher listing is reconciled complete.",
    );
  });

  test("with nothing to narrow by reads every source of the country", () => {
    const coverage = decisionAbsenceCoverage({
      snapshot: SNAPSHOT,
      country: "CZE",
      intent: docketIntent("12 Co 4/2024"),
      grammar: CZE,
      namedCourts: [],
    });
    expect(coverage.sources.map(({ source }) => source)).toEqual([
      "cz-ns",
      "cz-regional",
      "cz-us",
    ]);
  });
});

describe("a 1970 Supreme Court docket", () => {
  /** The collection, registered and holding nothing yet. */
  const COLLECTION: AbsenceCoverageSource = {
    adapterKey: "cz-ns-sbirka",
    name: "Nejvyšší soud",
    decisionYearFrom: null,
    decisionYearTo: null,
    knownGaps: reconciled([]),
    courts: [],
  };
  const declaredFrom = Number(
    ADAPTER_MANIFESTS["cz-ns-sbirka"].dateRange.fromInclusive.slice(0, 4),
  );

  test("the collection declares decisions from before 1970", () => {
    expect(ADAPTER_MANIFESTS["cz-ns-sbirka"].dateRange.type).toBe(
      "decision-date",
    );
    expect(declaredFrom).toBeLessThanOrEqual(1970);
  });

  test("names the collection over the years its publisher declares", () => {
    const coverage = decisionAbsenceCoverage({
      snapshot: {
        ...SNAPSHOT,
        countries: [
          {
            country: "CZE",
            sources: [SUPREME, REGIONAL, CONSTITUTIONAL, COLLECTION],
          },
        ],
      },
      country: "CZE",
      intent: docketIntent("6 Cz 90/70"),
      grammar: CZE,
      namedCourts: [],
    });
    const collection = coverage.sources.find(
      ({ source }) => source === "cz-ns-sbirka",
    );
    expect(collection).toEqual({
      verdict: "incomplete",
      source: "cz-ns-sbirka",
      sourceName: "Nejvyšší soud",
      years: { from: declaredFrom, to: 2026 },
      gapYears: [],
      unreconciledYears: [{ from: declaredFrom, to: 2026 }],
    });
    expect(decisionAbsenceHint(coverage)).toContain(
      `cz-ns-sbirka ${String(declaredFrom)}–2026`,
    );
  });

  test("names the collection beside the database when the citation names the court", () => {
    const coverage = decisionAbsenceCoverage({
      snapshot: {
        ...SNAPSHOT,
        countries: [
          {
            country: "CZE",
            sources: [
              SUPREME,
              REGIONAL,
              { ...COLLECTION, courts: [{ court: "Nejvyšší soud" }] },
            ],
          },
        ],
      },
      country: "CZE",
      intent: docketIntent("6 Cz 90/70"),
      grammar: CZE,
      namedCourts: ["Nejvyšší soud"],
    });
    expect(coverage.sources.map(({ source }) => source)).toEqual([
      "cz-ns",
      "cz-ns-sbirka",
    ]);
  });
});

describe("exclusive docket registers", () => {
  test("no register is kept by two sources of one country", () => {
    const byCountry = new Map<string, string[]>();
    for (const { key, country } of Object.values(ADAPTER_MANIFESTS)) {
      byCountry.set(country, [
        ...(byCountry.get(country) ?? []),
        ...EXCLUSIVE_DOCKET_REGISTERS[key].map((mark) =>
          mark.toLocaleLowerCase("cs"),
        ),
      ]);
    }
    for (const marks of byCountry.values()) {
      expect(new Set(marks).size).toBe(marks.length);
    }
  });

  test("each source's own fixture docket carries one of its registers", async () => {
    for (const [adapterKey, fixture] of Object.entries(
      CASE_LAW_CONFORMANCE_FIXTURES,
    )) {
      const marks: readonly string[] = Object.hasOwn(
        EXCLUSIVE_DOCKET_REGISTERS,
        adapterKey,
      )
        ? (Object.entries(EXCLUSIVE_DOCKET_REGISTERS).find(
            ([key]) => key === adapterKey,
          )?.[1] ?? [])
        : [];
      if (marks.length === 0) {
        continue;
      }
      try {
        const decision = plainTextIngestionResult(
          await fixture().buildDecision(),
        );
        const register = docketRegisterOf(decision.caseNumber);
        expect({ adapterKey, register }).toEqual({
          adapterKey,
          register: marks.find(
            (mark) =>
              mark.toLocaleLowerCase("cs") ===
              register?.toLocaleLowerCase("cs"),
          ),
        });
      } finally {
        testFetchState.restore();
      }
    }
  });
});
