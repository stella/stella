import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { STATED_DATE_RELATIONS } from "@stll/api-contract/provision-applied-version";
import { assertProperty } from "@stll/property-testing";

import { PROVISION_CITATION_JURISDICTIONS } from "./provision-citation-profile";
import { PROVISION_CITATION_PROFILES } from "./provision-citation-profiles";
import { parseProvisionAppliedVersion } from "./provision-version-grammar";

const profiles = Object.values(PROVISION_CITATION_PROFILES);
const date = fc
  .record({
    year: fc.integer({ min: 1918, max: 9999 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
  })
  .filter(
    ({ year, month, day }) =>
      new Date(Date.UTC(year, month - 1, day)).getUTCMonth() === month - 1,
  );
const gap = fc.constantFrom(" ", "  ", "\t", "\u00a0", "\n");
const prefix = fc.string({ maxLength: 50 }).map((value) => `${value}; `);

test("every registered profile requires an explicit version grammar", () => {
  expect(profiles.map((profile) => profile.jurisdiction).toSorted()).toEqual(
    [...PROVISION_CITATION_JURISDICTIONS].toSorted(),
  );
  for (const profile of profiles) {
    expect(
      [
        ...new Set(
          profile.versionGrammar.dateStatements.map(({ relation }) => relation),
        ),
      ].toSorted(),
    ).toEqual([...STATED_DATE_RELATIONS].toSorted());
    expect(profile.versionGrammar.amendmentPrefixes.length).toBeGreaterThan(0);
    expect(new Set(Object.values(profile.versionGrammar.monthNames)).size).toBe(
      12,
    );
  }
});

test("version dates preserve calendar values relations and exact evidence in every profile", () => {
  assertProperty(
    "version dates preserve calendar values relations and exact evidence in every profile",
    fc.property(
      date,
      gap,
      prefix,
      fc.boolean(),
      ({ year, month, day }, space, before, named) => {
        for (const profile of profiles) {
          for (const statement of profile.versionGrammar.dateStatements) {
            const monthName =
              Object.entries(profile.versionGrammar.monthNames).find(
                ([, value]) => value === month,
              )?.[0] ?? panic("Profile month spelling is absent");
            for (const printedDate of [
              `${day}.${month}.${year}`,
              named
                ? `${day}.${space}${monthName}${space}${year}`
                : `${day}.${space}${month}.${space}${year}`,
            ]) {
              const printed = `${statement.prefix}${space}${printedDate}`;
              const text = `${before}${printed}; suffix`;
              const result = parseProvisionAppliedVersion(text, profile);
              expect(result).toEqual({
                type: "stated_date",
                date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
                relation: statement.relation,
                evidence: {
                  kind: "stated_date",
                  start: before.length,
                  end: before.length + printed.length,
                },
              });
              if (
                result.type === "stated_date" ||
                result.type === "stated_version"
              ) {
                expect(
                  text.slice(result.evidence.start, result.evidence.end),
                ).toBe(printed);
              }
              expect(
                parseProvisionAppliedVersion(text.toUpperCase(), profile),
              ).toEqual(result);
            }
          }
        }
      },
    ),
  );
});

test("amendment versions preserve work identity and exact evidence in every profile", () => {
  assertProperty(
    "amendment versions preserve work identity and exact evidence in every profile",
    fc.property(
      fc.integer({ min: 1, max: 999_999 }),
      fc.integer({ min: 1918, max: 9999 }),
      gap,
      prefix,
      (number, year, space, before) => {
        for (const profile of profiles) {
          for (const collection of profile.collections) {
            for (const spelling of collection.spellings) {
              for (const lead of profile.versionGrammar.amendmentPrefixes) {
                const printed = `${lead}${space}${number}/${year}${space}${spelling}`;
                expect(
                  parseProvisionAppliedVersion(
                    `${before}${printed}; suffix`,
                    profile,
                  ),
                ).toEqual({
                  type: "stated_version",
                  amendmentWorkIdentifier: `${number}/${year} ${collection.canonical}`,
                  evidence: {
                    kind: "stated_version",
                    start: before.length,
                    end: before.length + printed.length,
                  },
                });
              }
            }
          }
        }
      },
    ),
  );
});

test("invalid and unrelated dates never select a version in every profile", () => {
  assertProperty(
    "invalid and unrelated dates never select a version in every profile",
    fc.property(fc.integer({ min: 1918, max: 9999 }), gap, (year, space) => {
      for (const profile of profiles) {
        for (const { prefix: lead } of profile.versionGrammar.dateStatements) {
          for (const invalid of [
            `0.1.${year}`,
            `32.1.${year}`,
            `31.4.${year}`,
            `1.0.${year}`,
            `1.13.${year}`,
            `1.1.${year}0`,
            `1.1.${year}/2`,
            `1.1.${year}.2`,
          ]) {
            expect(
              parseProvisionAppliedVersion(
                `${lead}${space}${invalid}`,
                profile,
              ),
            ).toEqual({ type: "not_stated" });
          }
        }
        for (const lead of profile.versionGrammar.amendmentPrefixes) {
          for (const collection of profile.collections) {
            for (const invalid of [`0/${year}`, `1/0000`, `1/${year}0`]) {
              expect(
                parseProvisionAppliedVersion(
                  `${lead} ${invalid} ${collection.canonical}`,
                  profile,
                ),
              ).toEqual({ type: "not_stated" });
            }
          }
        }
        for (const generic of [
          "ve znění pozdějších předpisů",
          "v znení neskorších predpisov",
          `rozhodnutí ze dne 1.1.${year}`,
          "",
          "ve znění zákona č. 0/2013 Sb.",
        ]) {
          expect(parseProvisionAppliedVersion(generic, profile)).toEqual({
            type: "not_stated",
          });
        }
      }
    }),
  );
});

test("version dates validate leap days and distinguish competing statements", () => {
  for (const profile of profiles) {
    const lead =
      profile.versionGrammar.dateStatements.at(0)?.prefix ??
      panic("Profile date statement is absent");
    expect(
      parseProvisionAppliedVersion(`${lead} 29.2.2000`, profile).type,
    ).toBe("stated_date");
    expect(parseProvisionAppliedVersion(`${lead} 29.2.1900`, profile)).toEqual({
      type: "not_stated",
    });
    expect(
      parseProvisionAppliedVersion(
        `${lead} 1.1.2014; ${lead} 1.1.2015`,
        profile,
      ).type,
    ).toBe("ambiguous");
    expect(
      parseProvisionAppliedVersion(
        `${lead} 1.1.2014; ${lead} 1.1.2014`,
        profile,
      ).type,
    ).toBe("stated_date");
  }
});

test("every registered month spelling preserves its calendar month", () => {
  for (const profile of profiles) {
    for (const [monthName, month] of Object.entries(
      profile.versionGrammar.monthNames,
    )) {
      for (const statement of profile.versionGrammar.dateStatements) {
        const printed = `${statement.prefix} 1. ${monthName} 2014`;
        const parsed = parseProvisionAppliedVersion(printed, profile);
        expect(parsed).toEqual({
          type: "stated_date",
          date: `2014-${String(month).padStart(2, "0")}-01`,
          relation: statement.relation,
          evidence: { kind: "stated_date", start: 0, end: printed.length },
        });
      }
    }
  }
});
