import { describe, expect, test } from "bun:test";

import { ELI_COLLECTION_BY_STATUTE_ACT_COLLECTION } from "@stll/api-contract/statute-acts";
import {
  isStatuteQueryCountry,
  resolveStatuteAlias,
} from "@stll/api-contract/statute-aliases";
import { foldStatuteQuery } from "@stll/api-contract/statute-query-intent";

import type { WorkIdentifier } from "./provision-citation-profile";
import { PROVISION_CITATION_PROFILES } from "./provision-citation-profiles";

/**
 * Spellings both readers know whose present-day readings differ on purpose.
 * Courts keep `obč. zák.` for the 1964 civil code after the 2012 one took
 * effect; the statute box opens the code in force. The list may only shrink.
 */
const KNOWN_DIVERGENCES = [
  "cze obč. zák.: statute box 89/2012 sb, citation reader 40/1964 Sb.",
];

const ELI_COLLECTIONS: Record<string, string> =
  ELI_COLLECTION_BY_STATUTE_ACT_COLLECTION;

const describeWork = ({ number, year, collection }: WorkIdentifier) =>
  `${String(number)}/${String(year)} ${collection}`;

describe("statute box aliases and citation-reader profiles", () => {
  test("read every spelling both know as the same act today", () => {
    const divergences: string[] = [];
    for (const profile of Object.values(PROVISION_CITATION_PROFILES)) {
      const country = profile.jurisdiction.toLowerCase();
      if (!isStatuteQueryCountry(country)) {
        divergences.push(`${country}: no statute box aliases`);
        continue;
      }
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
            target.collection === ELI_COLLECTIONS[collection]
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
});
