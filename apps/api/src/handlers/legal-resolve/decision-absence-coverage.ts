/**
 * Why resolve did not find a decision, as far as the reconciled publisher
 * listings can tell.
 *
 * A bare `not_found` leaves a reader unable to tell a decision the publisher
 * never published from one stella failed to ingest, so readers re-scan the
 * publisher by hand. The coverage snapshot already knows, per source and
 * year, whether the publisher's listing was reconciled against the corpus and
 * found complete. This module reads that answer for the years an identifier
 * allows its decision to carry and the sources that could hold it, so every
 * `no_exact_identity` says which of the two it is. It is the only place the
 * verdict is made.
 */
import { panic, Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import type { DecisionDocketGrammar } from "@stll/api-contract/decision-docket-grammar";
import type { DecisionIdentifierIntent } from "@stll/api-contract/decision-query-intent";
import type {
  DecisionAbsenceCoverage,
  DecisionAbsenceSourceVerdict,
} from "@stll/api-contract/legal-resolve";

import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

/**
 * A source's reconciled-listing state, as the coverage snapshot reports it
 * (`knownGaps`): each reconciled year complete or with known misses.
 */
type AbsenceKnownGaps =
  | {
      type: "reconciled";
      years: readonly (
        | { year: number; type: "complete" }
        | { year: number; type: "gaps" | "unlisted"; missing: number }
      )[];
    }
  | { type: "not_reconciled"; reason: string };

/** What the verdict reads from one source of the coverage snapshot. */
export type AbsenceCoverageSource = {
  adapterKey: string;
  name: string;
  decisionYearFrom: number | null;
  decisionYearTo: number | null;
  knownGaps: AbsenceKnownGaps;
  courts: readonly { court: string | null }[];
};

/** What the verdict reads from the coverage snapshot. */
export type AbsenceCoverageSnapshot = {
  generatedAt: string;
  countries: readonly {
    country: string;
    sources: readonly AbsenceCoverageSource[];
  }[];
};

type YearRange = { from: number; to: number };

/**
 * The docket registers only the court a source publishes keeps, by source.
 * A docket naming no court is narrowed to the source keeping its register;
 * an empty list (a source with no register of its own, or several courts)
 * leaves every source of the country a candidate, which is less precise and
 * never wrong. `decision-absence-coverage.test.ts` holds each listed source's
 * conformance fixture to its own registers.
 */
export const EXCLUSIVE_DOCKET_REGISTERS = {
  [ADAPTER_KEYS.CZ_REGIONAL]: [],
  [ADAPTER_KEYS.CZ_NS]: ["Cdo", "Cdon", "Odo", "Odon", "Tdo", "ICdo", "NSČR"],
  [ADAPTER_KEYS.CZ_NSS]: [
    "As",
    "Afs",
    "Ads",
    "Azs",
    "Ars",
    "Aps",
    "Ans",
    "Ao",
    "Komp",
    "Konf",
  ],
  [ADAPTER_KEYS.CZ_US]: ["ÚS"],
  [ADAPTER_KEYS.CZ_UOHS]: [],
  [ADAPTER_KEYS.SK_COURTS]: [],
  [ADAPTER_KEYS.SK_US]: [],
  [ADAPTER_KEYS.PL_COURTS]: [],
  [ADAPTER_KEYS.PL_SN]: [],
  [ADAPTER_KEYS.PL_KIO]: [],
  [ADAPTER_KEYS.PL_TK]: [],
  [ADAPTER_KEYS.PL_NSA]: [],
  [ADAPTER_KEYS.PL_NCOURT]: [],
  [ADAPTER_KEYS.PL_KIS]: [],
  [ADAPTER_KEYS.PL_UODO]: [],
  [ADAPTER_KEYS.PL_UOKIK]: [],
  [ADAPTER_KEYS.AT_COURTS]: [],
  [ADAPTER_KEYS.AT_VFGH]: [],
  [ADAPTER_KEYS.AT_VWGH]: [],
  [ADAPTER_KEYS.AT_BVWG]: [],
  [ADAPTER_KEYS.AT_LVWG]: [],
  [ADAPTER_KEYS.AT_ASYLGH]: [],
  [ADAPTER_KEYS.AT_UBAS]: [],
  [ADAPTER_KEYS.AT_UVS]: [],
  [ADAPTER_KEYS.AT_VERG]: [],
  [ADAPTER_KEYS.AT_UMSE]: [],
  [ADAPTER_KEYS.AT_BKS]: [],
  [ADAPTER_KEYS.AT_FINDOK]: [],
  [ADAPTER_KEYS.EU_ECJ]: [],
  [ADAPTER_KEYS.HU_BHGY]: [],
  [ADAPTER_KEYS.UK_FCL]: [],
  [ADAPTER_KEYS.BR_TJDFT]: [],
  // The collection prints every register of the courts it selects from.
  [ADAPTER_KEYS.CZ_NS_SBIRKA]: [],
  // The high courts' registers are the courts' database's too.
  [ADAPTER_KEYS.CZ_ISIR]: [],
  [ADAPTER_KEYS.BR_TST]: [],
} as const satisfies Record<AdapterKey, readonly string[]>;

const NUMBER_AND_YEAR_RE = /^\d+\/\d+/u;
const LETTERS_RE = /^\p{L}+$/u;

/**
 * The register mark of a docket as a grammar formats it: the word of letters
 * just before its number and year (`Cdo` in `29 Cdo 4084/2009`, `ÚS` in
 * `I. ÚS 12/20`).
 */
export const docketRegisterOf = (docket: string): string | undefined => {
  const words = docket.split(" ");
  const numbered = words.findIndex((word) => NUMBER_AND_YEAR_RE.test(word));
  const register = numbered > 0 ? words[numbered - 1] : undefined;
  return register !== undefined && LETTERS_RE.test(register)
    ? register
    : undefined;
};

const foldRegister = (register: string) => register.toLocaleLowerCase("cs");

/** The source of `country` keeping `register` alone, if one does. */
const sourceOfRegister = (
  country: string,
  register: string,
): string | undefined =>
  Object.values(ADAPTER_MANIFESTS).find(
    ({ key, country: sourceCountry }) =>
      sourceCountry === country &&
      EXCLUSIVE_DOCKET_REGISTERS[key].some(
        (mark) => foldRegister(mark) === foldRegister(register),
      ),
  )?.key;

const ECLI_YEAR_RE = /^ECLI:[A-Z]{2}:[A-Z0-9]{1,12}:(?<year>\d{4}):/iu;
const TRAILING_YEAR_RE = /\/(?<year>(?:19|20)\d{2})(?:\D|$)/u;

/**
 * The first year the named decision can carry in a listing: the docket's
 * filing year, the ECLI's year, or a year a stored reference prints. Null
 * when the identifier states none.
 */
const earliestYearOf = (
  intent: DecisionIdentifierIntent,
  grammar: DecisionDocketGrammar | null,
): number | null => {
  const yearOf = (match: RegExpExecArray | null) => {
    const year = parseIntegerToken(match?.groups?.["year"], {
      sign: "unsigned",
    });
    return Result.isOk(year) ? year.value : null;
  };
  switch (intent.kind) {
    case "docket": {
      const filing = grammar?.filingYear(intent.family);
      return filing?.type === "known" ? filing.year : null;
    }
    case "ecli":
      return yearOf(ECLI_YEAR_RE.exec(intent.value));
    case "neutral":
    case "reporter":
    case "reference":
      return yearOf(TRAILING_YEAR_RE.exec(intent.value));
    default: {
      intent satisfies never;
      return panic(`Unhandled decision identifier: ${String(intent)}`);
    }
  }
};

/** Ascending consecutive years folded into ranges. */
const rangesOf = (years: readonly number[]): YearRange[] => {
  const ranges: YearRange[] = [];
  for (const year of years) {
    const last = ranges.at(-1);
    if (last !== undefined && last.to + 1 === year) {
      last.to = year;
    } else {
      ranges.push({ from: year, to: year });
    }
  }
  return ranges;
};

/**
 * One source's verdict over `years`. Every year is read from the reconciled
 * ledger: complete, with known misses, or absent from it (not reconciled).
 */
export const sourceAbsenceVerdict = (
  source: AbsenceCoverageSource,
  years: YearRange,
): DecisionAbsenceSourceVerdict => {
  const identity = { source: source.adapterKey, sourceName: source.name };
  const gaps = source.knownGaps;
  if (gaps.type === "not_reconciled") {
    return { verdict: "not_reconciled", ...identity, reason: gaps.reason };
  }
  const byYear = new Map(gaps.years.map((entry) => [entry.year, entry]));
  const gapYears: { year: number; missing: number }[] = [];
  const unreconciled: number[] = [];
  for (let year = years.from; year <= years.to; year += 1) {
    const entry = byYear.get(year);
    if (entry === undefined) {
      unreconciled.push(year);
    } else if (entry.type !== "complete") {
      gapYears.push({ year, missing: entry.missing });
    }
  }
  return gapYears.length === 0 && unreconciled.length === 0
    ? { verdict: "not_published", ...identity, years }
    : {
        verdict: "incomplete",
        ...identity,
        years,
        gapYears,
        unreconciledYears: rangesOf(unreconciled),
      };
};

type DecisionAbsenceInput = {
  snapshot: AbsenceCoverageSnapshot;
  country: string;
  intent: DecisionIdentifierIntent;
  grammar: DecisionDocketGrammar | null;
  /** Courts the citation names, as the court directory reads them. */
  namedCourts: readonly string[];
};

/**
 * The sources that could hold the decision: those publishing a court the
 * citation names, else the one source keeping the docket's register, else
 * every source of the country.
 */
const candidateSources = ({
  sources,
  country,
  intent,
  namedCourts,
}: {
  sources: readonly AbsenceCoverageSource[];
  country: string;
  intent: DecisionIdentifierIntent;
  namedCourts: readonly string[];
}): readonly AbsenceCoverageSource[] => {
  if (namedCourts.length > 0) {
    const publishing = sources.filter((source) =>
      source.courts.some(
        ({ court }) => court !== null && namedCourts.includes(court),
      ),
    );
    if (publishing.length > 0) {
      return publishing;
    }
  }
  const register =
    intent.kind === "docket" ? docketRegisterOf(intent.family) : undefined;
  const owner =
    register === undefined ? undefined : sourceOfRegister(country, register);
  const owned = sources.filter((source) => source.adapterKey === owner);
  return owned.length > 0 ? owned : sources;
};

/**
 * The first year a source's publisher can hold, where its manifest declares
 * its coverage in decision dates. It bounds the years read for a source that
 * holds nothing yet: such a source states no held range, and the identifier
 * may state no year either (a two-digit docket year the grammar does not
 * read), so without it the range would shrink to the current year and name
 * none of the publisher's own.
 */
const declaredDecisionYearFrom = (adapterKey: string): number | null => {
  const manifest = Object.values(ADAPTER_MANIFESTS).find(
    ({ key }) => key === adapterKey,
  );
  if (manifest?.dateRange.type !== "decision-date") {
    return null;
  }
  const year = parseIntegerToken(manifest.dateRange.fromInclusive.slice(0, 4), {
    sign: "unsigned",
  });
  return Result.isOk(year) ? year.value : null;
};

export const decisionAbsenceCoverage = ({
  snapshot,
  country,
  intent,
  grammar,
  namedCourts,
}: DecisionAbsenceInput): Extract<
  DecisionAbsenceCoverage,
  { status: "read" }
> => {
  const sources =
    snapshot.countries.find((entry) => entry.country === country)?.sources ??
    [];
  const earliest = earliestYearOf(intent, grammar);
  // The ledger can say nothing past the moment the snapshot was taken, so
  // the snapshot's year closes every range.
  const snapshotYear = parseIntegerToken(snapshot.generatedAt.slice(0, 4), {
    sign: "unsigned",
  });
  const currentYear = Result.isOk(snapshotYear)
    ? snapshotYear.value
    : panic(`Coverage snapshot has no year: ${snapshot.generatedAt}`);
  return {
    status: "read",
    asOf: snapshot.generatedAt,
    sources: candidateSources({ sources, country, intent, namedCourts }).map(
      (source) =>
        sourceAbsenceVerdict(source, {
          from: Math.min(
            earliest ??
              source.decisionYearFrom ??
              declaredDecisionYearFrom(source.adapterKey) ??
              currentYear,
            currentYear,
          ),
          to: currentYear,
        }),
    ),
  };
};

const yearsText = ({ from, to }: YearRange) =>
  from === to ? String(from) : `${String(from)}–${String(to)}`;

/**
 * The next step the verdicts allow, for the `hint` of the answer: stop where
 * every candidate listing is complete, else name the years still open.
 */
export const decisionAbsenceHint = (
  coverage: DecisionAbsenceCoverage,
): string | undefined => {
  if (coverage.status !== "read" || coverage.sources.length === 0) {
    return undefined;
  }
  if (coverage.sources.every(({ verdict }) => verdict === "not_published")) {
    return "coverage: every candidate publisher listing is reconciled complete for these years; the publisher has not published this decision. Do not scan the publisher.";
  }
  const open = coverage.sources.flatMap((source) => {
    switch (source.verdict) {
      case "not_published":
        return [];
      case "incomplete": {
        const years = [
          ...source.gapYears.map(({ year }) => String(year)),
          ...source.unreconciledYears.map(yearsText),
        ];
        return [`${source.source} ${years.join(", ")}`];
      }
      case "not_reconciled":
        return [`${source.source} (not reconciled)`];
      default: {
        source satisfies never;
        return panic(`Unhandled verdict: ${String(source)}`);
      }
    }
  });
  return `coverage: stella may lack it only in ${open.join("; ")}; elsewhere the publisher listing is reconciled complete.`;
};
