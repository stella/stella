import { panic } from "better-result";

import type { AppliedProvisionVersion } from "@stll/api-contract/provision-applied-version";

import {
  formatWorkIdentifier,
  type JurisdictionProfile,
} from "./provision-citation-profile";

const phrasePattern = (phrase: string): string =>
  phrase
    .split(/\s+/u)
    .map((word) => RegExp.escape(word))
    .join("\\s+");

const alternatives = (phrases: readonly string[]): string =>
  phrases
    .toSorted((a, b) => b.length - a.length)
    .map(phrasePattern)
    .join("|");

export type ProvisionVersionParseResult =
  | AppliedProvisionVersion
  | {
      type: "ambiguous";
      statements: readonly Exclude<
        AppliedProvisionVersion,
        { type: "not_stated" }
      >[];
    };

const validDate = (year: number, month: number, day: number): boolean => {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximum = days.at(month - 1);
  return maximum !== undefined && day <= maximum;
};

/**
 * Reads one citation's context. Evidence offsets address this exact input in
 * UTF-16 code units. Callers associate the context with a provision; this
 * grammar does not pair statements across an entire decision.
 * Conflicting statements return an ambiguity outcome; repeated statements
 * identifying the same version converge to their first evidence span.
 */
export const parseProvisionAppliedVersion = (
  text: string,
  profile: JurisdictionProfile,
): ProvisionVersionParseResult => {
  const candidates: Exclude<AppliedProvisionVersion, { type: "not_stated" }>[] =
    [];
  const { versionGrammar } = profile;
  const months = alternatives(Object.keys(versionGrammar.monthNames));
  const datePattern = `(?<day>\\d{1,2})\\.\\s*(?:(?<month>\\d{1,2})\\.\\s*|(?<monthName>${months})\\s+)(?<year>\\d{4})(?![\\p{L}\\p{N}/]|\\.\\d)`;
  for (const { prefix, relation } of versionGrammar.dateStatements) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${phrasePattern(prefix)}\\s+${datePattern}`,
      "giu",
    );
    for (const match of text.matchAll(pattern)) {
      const day = Number(match.groups?.["day"]);
      const year = Number(match.groups?.["year"]);
      const monthName = match.groups?.["monthName"];
      const month =
        monthName === undefined
          ? Number(match.groups?.["month"])
          : versionGrammar.monthNames[monthName.toLowerCase()];
      if (month === undefined || !validDate(year, month, day)) {
        continue;
      }
      candidates.push({
        type: "stated_date",
        date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        relation,
        evidence: {
          kind: "stated_date",
          start: match.index,
          end: match.index + match[0].length,
        },
      });
    }
  }
  for (const collection of profile.collections) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${alternatives(versionGrammar.amendmentPrefixes)})\\s*(?<number>\\d{1,6})\\s*/\\s*(?<year>\\d{4})\\s*(?:${alternatives(collection.spellings)})(?![\\p{L}\\p{N}])`,
      "giu",
    );
    for (const match of text.matchAll(pattern)) {
      const number = Number(match.groups?.["number"]);
      const year = Number(match.groups?.["year"]);
      if (number < 1 || year < profile.earliestYear) {
        continue;
      }
      candidates.push({
        type: "stated_version",
        amendmentWorkIdentifier: formatWorkIdentifier({
          number,
          year,
          collection: collection.canonical,
        }),
        evidence: {
          kind: "stated_version",
          start: match.index,
          end: match.index + match[0].length,
        },
      });
    }
  }
  // A shorter collection spelling can prefix a longer one (Sb. / Sb. m. s.).
  const statements = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other.evidence.start === candidate.evidence.start &&
          other.evidence.end > candidate.evidence.end,
      ),
  );
  const first = statements.at(0);
  if (first === undefined) {
    return { type: "not_stated" };
  }
  const agrees = statements.every((statement) => {
    switch (statement.type) {
      case "stated_date":
        return (
          first.type === "stated_date" &&
          first.date === statement.date &&
          first.relation === statement.relation
        );
      case "stated_version":
        return (
          first.type === "stated_version" &&
          first.amendmentWorkIdentifier === statement.amendmentWorkIdentifier
        );
      default: {
        statement satisfies never;
        return panic("Unknown provision version statement");
      }
    }
  });
  return agrees ? first : { type: "ambiguous", statements };
};
