import { panic } from "better-result";

import type {
  BirthDate,
  Country,
  EntityType,
  Identifier,
  SanctionsName,
} from "./entry";
import { nameIndexSteps, runSteps } from "./name-match";
import { addIdentifierPostings } from "./screening";
import type { ScreenedRecords } from "./screening";
import { IdentifierPostings } from "./screening-entries";
import { screeningWorkStatsSteps } from "./screening-work-bound";

/**
 * A named party outside the sanctions lists, such as a firm's own contact.
 * `ref` is the caller's identity for the party; the matcher never reads it.
 */
export type ScreenedParty<TRef> = {
  ref: TRef;
  entityType: EntityType;
  /** Every name the party goes by, primary first. */
  names: SanctionsName[];
  birthDates: BirthDate[];
  nationalities: Country[];
  identifiers: Identifier[];
};

export type PartyIndex<TRef> = ScreenedRecords<
  ScreenedParty<TRef>,
  ScreenedParty<TRef>
>;

/**
 * Indexes a set of parties for `screenRecords`, with the same name
 * normalisation, token weighting and identity evidence as a sanctions
 * screening. Built in one pass: callers index a bounded set.
 *
 * `compare` orders parties that score the same, so a result never depends on
 * the order the parties were read in.
 */
export const buildPartyIndex = <TRef>(
  parties: readonly ScreenedParty<TRef>[],
  compare: (left: TRef, right: TRef) => number,
): PartyIndex<TRef> => {
  const identifierEntries = new IdentifierPostings();
  for (const [entryIndex, party] of parties.entries()) {
    addIdentifierPostings({
      postings: identifierEntries,
      entryIndex,
      identifiers: party.identifiers,
    });
  }
  const entries = {
    length: parties.length,
    get: (id: number) => parties[id] ?? panic("Missing indexed party"),
  };
  const names = runSteps(nameIndexSteps(parties));
  return {
    entries,
    names,
    workStats: runSteps(screeningWorkStatsSteps(names, entries)),
    identifierEntries,
    hydrate: entries.get,
    compare: (left, right) => compare(left.ref, right.ref),
  };
};
