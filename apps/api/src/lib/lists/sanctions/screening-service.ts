import { panic, Result, TaggedError } from "better-result";
import type { TaggedErrorClass } from "better-result";

import type { CountryCode } from "@stll/country-codes";
import {
  buildScreeningIndex,
  DEFAULT_CUTOFF,
  MAX_QUERY_TOKENS,
  SANCTIONS_SOURCES,
  screen,
} from "@stll/sanctions";
import type {
  EntityType,
  FieldComparison,
  IdentityField,
  PossibleMatch,
  QueryBirthDate,
  SanctionsIssuer,
  SanctionsSource,
  ScreeningQuery,
  ScreeningQueryError,
} from "@stll/sanctions";

import { classifySanctionsIssuer } from "@/api/lib/lists/sanctions/classification";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import type { SanctionsSourceFreshness } from "@/api/lib/lists/sanctions/freshness";
import type { SanctionsReadDb } from "@/api/lib/lists/sanctions/read-db";
import { sharedSanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import type { SanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import type {
  SanctionsClassification,
  SanctionsPendingUpdateCode,
  SanctionsScreeningStatus,
  SanctionsUnavailableReason,
} from "@/api/lib/lists/sanctions/screening-vocabulary";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";

// One screening service for every surface that screens a name: the
// counterparty check now and the public search later. Both read the same
// active editions through the same index, cutoff and freshness rules, so a
// query answers the same everywhere. Nothing tenant-specific is read here:
// the firm's practice jurisdictions, which only label each list, are an
// input.
//
// Names, birth dates and nationalities are personal data. Nothing in this
// module logs, and callers must not log the subject either.

/** Possible matches returned per list; `totalMatches` counts the rest. */
export const SANCTIONS_MATCH_LIMIT = 10;

/** Who is screened. Identity fields are optional; each one narrows matches. */
export type SanctionsScreeningSubject =
  | {
      type: "organization";
      name: string;
      /** Registration or tax numbers, in any formatting. */
      identifiers: readonly string[];
    }
  | {
      type: "person";
      name: string;
      /** At the precision known; a missing month or day is never invented. */
      birthDate: QueryBirthDate | null;
      nationalityCodes: readonly CountryCode[];
    };

type SanctionsPossibleMatch = {
  sourceEntryId: string;
  editionId: string;
  /** 0..1, at or above the cutoff. A possible match needs human review. */
  score: number;
  /** The publisher's page or file for the entry. */
  sourceUrl: string;
  /** The entry's primary listed name. */
  name: string | null;
  referenceNumber: string | null;
  entityType: EntityType;
  programme: string | null;
  listedOn: string | null;
  evidence: {
    nameScore: number;
    matchedName: string | null;
    birthDate: FieldComparison;
    nationality: FieldComparison;
    entityType: FieldComparison;
    identifier: FieldComparison;
    /** Identity fields that contradict the listing; the match is still reported. */
    conflicts: IdentityField[];
  };
};

/**
 * A newer edition the refresh fetched but held back for review; the list
 * still screens against the edition it had. Null when nothing is held.
 */
type SanctionsPendingUpdate = {
  code: SanctionsPendingUpdateCode;
  /** When the edition was held. */
  heldAt: string;
  /** Entries in the edition in use, and in the held one, when known. */
  previousCount: number | null;
  nextCount: number | null;
};

// The screening's `checkedAt` is every list's; the issuer code names the
// issuer.
type ListOutcomeBase = {
  source: SanctionsSource;
  issuer: SanctionsIssuer;
  classification: SanctionsClassification;
  pendingUpdate: SanctionsPendingUpdate | null;
};

type ScreenedEdition = {
  /** The exact edition screened against. */
  editionId: string;
  /** When the publisher issued the edition. */
  publishedAt: string;
  /** When the edition was last confirmed current at the publisher. */
  verifiedAt: string;
};

/** One list's answer. Every list is reported, including the unavailable ones. */
export type SanctionsListOutcome =
  | (ListOutcomeBase &
      ScreenedEdition & {
        status: "clear";
        reason: null;
        totalMatches: 0;
        truncated: false;
        possibleMatches: [];
      })
  | (ListOutcomeBase &
      ScreenedEdition & {
        status: "possible-match";
        reason: null;
        totalMatches: number;
        truncated: boolean;
        possibleMatches: [SanctionsPossibleMatch, ...SanctionsPossibleMatch[]];
      })
  | (ListOutcomeBase & {
      status: "unavailable";
      reason: SanctionsUnavailableReason;
      /** The latest edition on file, if any; nothing was screened against it. */
      editionId: string | null;
      publishedAt: string | null;
      verifiedAt: string | null;
      totalMatches: 0;
      truncated: false;
      possibleMatches: [];
    });

export type SanctionsScreening = {
  /**
   * `possible-match` when any list has one; otherwise `unavailable` when any
   * list could not answer; `clear` only when every list answered clear.
   */
  status: SanctionsScreeningStatus;
  checkedAt: string;
  cutoff: number;
  lists: SanctionsListOutcome[];
};

const SanctionsSubjectErrorBase: TaggedErrorClass<"SanctionsSubjectError"> =
  TaggedError("SanctionsSubjectError");

export const SANCTIONS_SUBJECT_ERROR_MESSAGES = {
  "empty-query": "The name to screen has no letters",
  "invalid-birth-date": "The date of birth is not a valid calendar date",
  "excess-query-tokens": `The name to screen must contain at most ${MAX_QUERY_TOKENS} normalized tokens`,
} as const satisfies Record<ScreeningQueryError["code"], string>;

/** The subject cannot be screened as given; the caller corrects it. */
export class SanctionsSubjectError extends SanctionsSubjectErrorBase<{
  code: ScreeningQueryError["code"];
  message: string;
}> {}

const EMPTY_INDEX = buildScreeningIndex([]);

const toScreeningQuery = (
  subject: SanctionsScreeningSubject,
  nameSource: NonNullable<ScreeningQuery["nameSource"]>,
): ScreeningQuery => {
  switch (subject.type) {
    case "organization": {
      return {
        name: subject.name,
        nameSource,
        entityType: "organisation",
        identifiers: subject.identifiers,
      };
    }
    case "person": {
      return {
        name: subject.name,
        nameSource,
        entityType: "person",
        ...(subject.birthDate !== null && { birthDate: subject.birthDate }),
        nationality: subject.nationalityCodes,
      };
    }
    default: {
      subject satisfies never;
      return panic("Unhandled sanctions subject");
    }
  }
};

const aggregateSanctionsStatus = (
  lists: readonly SanctionsListOutcome[],
): SanctionsScreeningStatus => {
  if (lists.some((list) => list.status === "possible-match")) {
    return "possible-match";
  }
  if (
    lists.length === 0 ||
    lists.some((list) => list.status === "unavailable")
  ) {
    return "unavailable";
  }
  return "clear";
};

const toPendingUpdate = (
  heldUpdate: SanctionsSourceFreshness["heldUpdate"],
): SanctionsPendingUpdate | null =>
  heldUpdate === null
    ? null
    : {
        code: heldUpdate.code,
        heldAt: heldUpdate.at.toISOString(),
        previousCount: heldUpdate.previousCount,
        nextCount: heldUpdate.nextCount,
      };

const listBase = ({
  source,
  practiceJurisdictions,
  heldUpdate,
}: {
  source: SanctionsSource;
  practiceJurisdictions: readonly CountryCode[];
  heldUpdate: SanctionsSourceFreshness["heldUpdate"];
}): ListOutcomeBase => {
  const { issuer } = SANCTIONS_SOURCES[source];
  return {
    source,
    issuer,
    classification: classifySanctionsIssuer(issuer, practiceJurisdictions),
    pendingUpdate: toPendingUpdate(heldUpdate),
  };
};

const unavailableList = (
  base: ListOutcomeBase,
  reason: SanctionsUnavailableReason,
  freshness: SanctionsSourceFreshness | null,
): SanctionsListOutcome => ({
  ...base,
  status: "unavailable",
  reason,
  editionId: freshness?.edition?.id ?? null,
  publishedAt: freshness?.edition?.publishedAt ?? null,
  verifiedAt: freshness?.lastSuccessfulVerifiedAt?.toISOString() ?? null,
  totalMatches: 0,
  truncated: false,
  possibleMatches: [],
});

const toPossibleMatch = (
  match: PossibleMatch,
  editionId: string,
): SanctionsPossibleMatch => ({
  sourceEntryId: match.entry.sourceId,
  editionId,
  score: match.score,
  sourceUrl: match.entry.sourceUrl,
  name: match.entry.names.at(0)?.name ?? null,
  referenceNumber: match.entry.referenceNumber,
  entityType: match.entry.entityType,
  programme: match.entry.programme,
  listedOn: match.entry.listedOn,
  evidence: {
    nameScore: match.evidence.nameScore,
    matchedName: match.evidence.matchedName,
    birthDate: match.evidence.birthDate,
    nationality: match.evidence.nationality,
    entityType: match.evidence.entityType,
    identifier: match.evidence.identifier,
    conflicts: [...match.evidence.conflicts],
  },
});

type ScreenListProps = {
  db: SanctionsReadDb;
  freshness: SanctionsSourceFreshness;
  query: ScreeningQuery;
  base: ListOutcomeBase;
  indexCache: SanctionsIndexCache;
};

const screenList = async ({
  db,
  freshness,
  query,
  base,
  indexCache,
}: ScreenListProps): Promise<SanctionsListOutcome> => {
  const { edition, lastSuccessfulVerifiedAt } = freshness;
  // Stale or missing data never answers: only a fresh edition can be clear.
  if (
    freshness.status === "unavailable" ||
    edition === null ||
    lastSuccessfulVerifiedAt === null
  ) {
    return unavailableList(base, freshness.reason ?? "not-loaded", freshness);
  }
  // Each list degrades on its own: a cache that rejects instead of answering
  // `load-failed` still leaves the other lists screening.
  const index = await Result.tryPromise(
    async () => await indexCache.get({ db, source: freshness.source, edition }),
  );
  if (index.isErr()) {
    return unavailableList(base, "load-failed", freshness);
  }
  if (index.value.isErr()) {
    return unavailableList(base, index.value.error.code, freshness);
  }
  const screened = screen(index.value.value, query, {
    cutoff: DEFAULT_CUTOFF,
    limit: SANCTIONS_MATCH_LIMIT,
  });
  if (screened.isErr()) {
    if (screened.error.code === "work-limit") {
      return unavailableList(base, "load-failed", freshness);
    }
    // The query was validated against an empty index first, and these
    // errors depend on the query alone.
    return panic("A validated sanctions query was rejected");
  }
  const screenedEdition: ScreenedEdition = {
    editionId: edition.id,
    publishedAt: edition.publishedAt,
    verifiedAt: lastSuccessfulVerifiedAt.toISOString(),
  };
  const [first, ...rest] = screened.value.possibleMatches.map((match) =>
    toPossibleMatch(match, edition.id),
  );
  if (first === undefined) {
    if (screened.value.truncated) {
      return unavailableList(base, "load-failed", freshness);
    }
    return {
      ...base,
      ...screenedEdition,
      status: "clear",
      reason: null,
      totalMatches: 0,
      truncated: false,
      possibleMatches: [],
    };
  }
  return {
    ...base,
    ...screenedEdition,
    status: "possible-match",
    reason: null,
    totalMatches: screened.value.totalMatches,
    truncated: screened.value.truncated,
    possibleMatches: [first, ...rest],
  };
};

type ScreenSanctionsSubjectProps = {
  /** Any handle that may read the global sanctions tables. */
  db: SanctionsReadDb;
  subject: SanctionsScreeningSubject;
  nameSource?: ScreeningQuery["nameSource"];
  /** The firm's practice jurisdictions; empty labels every list informational. */
  practiceJurisdictions: readonly CountryCode[];
  now?: Date | undefined;
  indexCache?: SanctionsIndexCache | undefined;
};

/**
 * Screen one subject against every registered list's active edition. Each
 * list answers for itself: a list that is stale, not loaded or unreadable is
 * `unavailable` and never `clear`, and the others still answer.
 */
export const screenSanctionsSubject = async ({
  db,
  subject,
  nameSource = "free-text",
  practiceJurisdictions,
  now = new Date(),
  indexCache = sharedSanctionsIndexCache,
}: ScreenSanctionsSubjectProps): Promise<
  Result<SanctionsScreening, SanctionsSubjectError>
> => {
  const query = toScreeningQuery(subject, nameSource);
  const validated = screen(EMPTY_INDEX, query, { cutoff: DEFAULT_CUTOFF });
  if (validated.isErr()) {
    if (validated.error.code === "work-limit") {
      return Result.ok(
        unavailableSanctionsScreening({
          reason: "load-failed",
          practiceJurisdictions,
          now,
        }),
      );
    }
    return Result.err(
      new SanctionsSubjectError({
        code: validated.error.code,
        message: validated.error.message,
      }),
    );
  }
  const checkedAt = now.toISOString();
  const freshness = await Result.tryPromise(
    async () => await readSanctionsFreshness({ db, now }),
  );
  if (freshness.isErr()) {
    return Result.ok(
      unavailableSanctionsScreening({
        reason: "load-failed",
        practiceJurisdictions,
        now,
      }),
    );
  }
  const lists: SanctionsListOutcome[] = [];
  for (const sourceFreshness of freshness.value) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    lists.push(
      // db-await-in-loop: one bounded read per sanctions source; sequential macrotask yields prevent warm indexes from monopolizing the event loop
      await screenList({
        db,
        freshness: sourceFreshness,
        query,
        base: listBase({
          source: sourceFreshness.source,
          practiceJurisdictions,
          heldUpdate: sourceFreshness.heldUpdate,
        }),
        indexCache,
      }),
    );
  }
  return Result.ok({
    status: aggregateSanctionsStatus(lists),
    checkedAt,
    cutoff: DEFAULT_CUTOFF,
    lists,
  });
};

/**
 * Every list unavailable for one reason, for a subject that could not be
 * screened at all (a company ID whose name could not be resolved).
 */
export const unavailableSanctionsScreening = ({
  reason,
  practiceJurisdictions,
  now = new Date(),
}: {
  reason: SanctionsUnavailableReason;
  practiceJurisdictions: readonly CountryCode[];
  now?: Date | undefined;
}): SanctionsScreening => {
  const checkedAt = now.toISOString();
  const lists = sanctionsSourceIds().map((source) =>
    unavailableList(
      listBase({
        source,
        practiceJurisdictions,
        // Nothing was read about the lists: no subject reached them.
        heldUpdate: null,
      }),
      reason,
      null,
    ),
  );
  return {
    status: aggregateSanctionsStatus(lists),
    checkedAt,
    cutoff: DEFAULT_CUTOFF,
    lists,
  };
};
