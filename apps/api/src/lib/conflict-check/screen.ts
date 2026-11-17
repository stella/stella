import { panic, Result } from "better-result";

import { CONFLICT_CHECK_LIMITS } from "@stll/api-contract/conflict-checks";
import type {
  ConflictMatchEvidence,
  ConflictMatchTier,
  ConflictParty,
} from "@stll/api-contract/conflict-checks";
import { DEFAULT_CUTOFF, screenRecords } from "@stll/sanctions";
import type {
  PartyIndex,
  RecordMatch,
  ScreenedParty,
  ScreeningQuery,
} from "@stll/sanctions";

import { identifierVariants } from "@/api/lib/conflict-check/identifiers";
import { compareContactIds } from "@/api/lib/conflict-check/party-index";
import type { ScreenedContact } from "@/api/lib/conflict-check/party-index";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * The sanctions matcher's evaluated cutoff: recall on perturbed names stays
 * near its ceiling while unrelated names rarely reach it. A missed conflict
 * costs more than a false hit, so the check does not raise it.
 */
const CONFLICT_MATCH_CUTOFF = DEFAULT_CUTOFF;
const STRONG_NAME_SCORE = 0.95;

type PartyMatch = {
  contact: ScreenedContact;
  tier: ConflictMatchTier;
  score: number;
  matchedName: string | null;
  evidence: ConflictMatchEvidence;
};

export type PartyScreening = {
  matches: PartyMatch[];
  totalMatches: number;
  truncated: boolean;
  /** The screening stopped at its work bound. */
  incomplete: boolean;
};

const queries = (party: ConflictParty): ScreeningQuery[] => {
  switch (party.type) {
    case "person": {
      const name = [party.firstName, party.middleName, party.lastName]
        .filter((part) => part !== undefined)
        .join(" ");
      const { dateOfBirth } = party;
      const birthDate = (): Pick<ScreeningQuery, "birthDate"> => {
        switch (dateOfBirth?.precision) {
          case undefined:
            return {};
          case "year":
            return { birthDate: { year: dateOfBirth.year } };
          case "month":
            return {
              birthDate: { year: dateOfBirth.year, month: dateOfBirth.month },
            };
          case "day":
            return {
              birthDate: {
                year: dateOfBirth.year,
                month: dateOfBirth.month,
                day: dateOfBirth.day,
              },
            };
          default: {
            dateOfBirth satisfies never;
            return panic("Unhandled birth date precision");
          }
        }
      };
      return [name, ...party.aliases].map((each): ScreeningQuery => ({
        name: each,
        entityType: "person",
        ...birthDate(),
      }));
    }
    case "organization": {
      const identifiers = [
        party.companyId,
        party.taxId,
        party.vatId,
        party.dataBoxId,
      ].flatMap((value) =>
        value === undefined ? [] : identifierVariants(value),
      );
      return [party.name, ...party.aliases].map((each): ScreeningQuery => ({
        name: each,
        entityType: "organisation",
        identifiers,
      }));
    }
    default: {
      party satisfies never;
      return panic("Unhandled conflict party type");
    }
  }
};

const tier = ({ evidence }: RecordMatch<unknown>): ConflictMatchTier => {
  if (evidence.identifier === "match") {
    return "identifier";
  }
  if (evidence.nameScore >= 1) {
    return "exact_name";
  }
  return evidence.nameScore >= STRONG_NAME_SCORE
    ? "strong_name"
    : "similar_name";
};

const partyMatch = (
  match: RecordMatch<ScreenedParty<ScreenedContact>>,
): PartyMatch => ({
  contact: match.entry.ref,
  tier: tier(match),
  score: match.score,
  matchedName: match.evidence.matchedName,
  evidence: {
    nameScore: match.evidence.nameScore,
    identifier: match.evidence.identifier,
    birthDate: match.evidence.birthDate,
    entityType: match.evidence.entityType,
  },
});

/**
 * Screens one party, by its name and each alias, against the firm's
 * contacts. A contact matched by several spellings keeps its best match. A
 * spelling the matcher cannot read is the caller's mistake (400); a screening
 * stopped at its work bound marks the party incomplete, never clear.
 */
export const screenConflictParty = ({
  index,
  party,
  partyIndex,
}: {
  index: PartyIndex<ScreenedContact>;
  party: ConflictParty;
  partyIndex: number;
}): Result<PartyScreening, HandlerError> => {
  const best = new Map<string, PartyMatch>();
  let totalMatches = 0;
  let truncated = false;
  let incomplete = false;
  for (const query of queries(party)) {
    const screened = screenRecords(index, query, {
      cutoff: CONFLICT_MATCH_CUTOFF,
      limit: CONFLICT_CHECK_LIMITS.hitsPerParty,
    });
    if (screened.isErr()) {
      const { error } = screened;
      if (error.code === "work-limit") {
        incomplete = true;
        continue;
      }
      return Result.err(
        new HandlerError({
          status: 400,
          code: "validation_error",
          message: `Party ${partyIndex + 1} cannot be screened: ${error.message}`,
          hint: "Give the party a name with letters, or an identifier of at least five characters.",
        }),
      );
    }
    totalMatches = Math.max(totalMatches, screened.value.totalMatches);
    truncated ||= screened.value.truncated;
    for (const match of screened.value.possibleMatches) {
      const known = best.get(match.entry.ref.id);
      if (known === undefined || match.score > known.score) {
        best.set(match.entry.ref.id, partyMatch(match));
      }
    }
  }
  const matches = [...best.values()].toSorted(
    (left, right) =>
      right.score - left.score ||
      compareContactIds(left.contact.id, right.contact.id),
  );
  return Result.ok({
    matches: matches.slice(0, CONFLICT_CHECK_LIMITS.hitsPerParty),
    totalMatches: Math.max(totalMatches, matches.length),
    truncated: truncated || matches.length > CONFLICT_CHECK_LIMITS.hitsPerParty,
    incomplete,
  });
};
