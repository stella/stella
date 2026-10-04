import { describe, expect, test } from "bun:test";

import { STATUTE_ACTS } from "@stll/api-contract/statute-acts";
import { resolveStatuteAlias } from "@stll/api-contract/statute-aliases";
import { statuteGazetteEliCollection } from "@stll/api-contract/statute-gazette";
import { readStatuteQueryScope } from "@stll/api-contract/statute-query-capability";
import { foldStatuteQuery } from "@stll/api-contract/statute-query-intent";

import type {
  JurisdictionProfile,
  WorkIdentifier,
} from "./provision-citation-profile";
import { PROVISION_CITATION_PROFILES } from "./provision-citation-profiles";

/**
 * Spellings both readers know whose present-day readings differ on purpose.
 * Courts keep `obč. zák.` for the 1964 civil code after the 2012 one took
 * effect; the statute box opens the code in force. The list may only shrink.
 */
const KNOWN_DIVERGENCES = [
  "cze obč. zák.: statute box 89/2012 sb, citation reader 40/1964 Sb.",
];

/** Read through the profile contract, where every entry may carry a window. */
const PROFILES: readonly JurisdictionProfile[] = Object.values(
  PROVISION_CITATION_PROFILES,
);

const describeWork = ({ number, year, collection }: WorkIdentifier) =>
  `${String(number)}/${String(year)} ${collection}`;

describe("statute box aliases and citation-reader profiles", () => {
  test("read every spelling both know as the same act today", () => {
    const divergences: string[] = [];
    for (const profile of PROFILES) {
      const scope = readStatuteQueryScope(profile.jurisdiction.toLowerCase());
      if (scope.type === "unsupported") {
        divergences.push(
          `${profile.jurisdiction}: no statute box aliases (${scope.reason})`,
        );
        continue;
      }
      const { country } = scope;
      for (const entry of [...profile.aliases, ...profile.titles]) {
        // An entry with an end date is a historical reading, not today's.
        if (entry.citedUntil !== undefined) {
          continue;
        }
        for (const spelling of entry.spellings) {
          const target = resolveStatuteAlias(
            country,
            foldStatuteQuery(spelling),
          );
          if (target === null) {
            continue;
          }
          const { number, year, collection } = entry.identifier;
          if (
            target.number === String(number) &&
            target.year === String(year) &&
            target.collection === statuteGazetteEliCollection(collection)
          ) {
            continue;
          }
          divergences.push(
            `${country} ${spelling}: statute box ${target.number}/${target.year} ${target.collection}, citation reader ${describeWork(entry.identifier)}`,
          );
        }
      }
    }
    expect(divergences).toEqual(KNOWN_DIVERGENCES);
  });

  // A profile that restates a shared act's number by hand would drift from it
  // silently; it must reference the shared identity instead.
  test("name every shared act by its shared identity", () => {
    const sharedWorks = Object.values(STATUTE_ACTS).flatMap((acts) =>
      Object.values(acts).map(({ work }) => work),
    );
    const restated: string[] = [];
    for (const profile of PROFILES) {
      for (const { identifier } of [...profile.aliases, ...profile.titles]) {
        const shared = sharedWorks.find(
          (work) => describeWork(work) === describeWork(identifier),
        );
        if (shared !== undefined && shared !== identifier) {
          restated.push(`${profile.jurisdiction} ${describeWork(identifier)}`);
        }
      }
    }
    expect(restated).toEqual([]);
  });
});
