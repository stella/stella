// Independent equivalence oracle captured from f3efe8009a.
import { Result, TaggedError, panic } from "better-result";

import type { CountryCode } from "@stll/country-codes";

import type {
  BirthDate,
  EntityType,
  ListVersion,
  ParsedList,
  SanctionsEntry,
} from "../entry";
import {
  nameReading,
  hasExcessQueryTokens,
  MAX_QUERY_TOKENS,
} from "../normalise";
import type { NameReading } from "../normalise";
import { isCalendarDate } from "../values";
import {
  matchNames,
  MAX_SCREENING_WORK,
  nameIndexSteps,
  runSteps,
  spendScreeningWork,
} from "./legacy-name-match";
import type {
  NameIndex,
  NameMatch,
  NameMatches,
  ScreeningWorkBudget,
} from "./legacy-name-match";

/**
 * Recommended cutoff, chosen with the evaluation in `src/evaluation`: recall
 * on perturbed listed names stays near its ceiling while clean names and
 * listed names with another birth date rarely reach it. Callers still pass a
 * cutoff explicitly.
 */
export const DEFAULT_CUTOFF = 0.8;

const DEFAULT_LIMIT = 20;
// Identifiers shorter than this collide by chance across unrelated entries.
const MIN_IDENTIFIER_LENGTH = 5;

// Identity fields move the name score toward 1 (by a share of the remaining
// distance) or scale it down.
const BIRTH_DATE_EXACT_BOOST = 0.5;
const BIRTH_DATE_APPROXIMATE_BOOST = 0.25;
const BIRTH_DATE_MISMATCH_FACTOR = 0.7;
const NATIONALITY_MATCH_BOOST = 0.15;
const NATIONALITY_MISMATCH_FACTOR = 0.9;
const ENTITY_TYPE_MISMATCH_FACTOR = 0.6;
// A wrong or stale client field must not hide a name that matches this well:
// such an entry stays reported at the cutoff, below every agreeing match, with
// the conflicting fields named in its evidence.
const STRONG_NAME_SCORE = 0.95;
// A date the list marks "circa" is trusted to within this many years.
const CIRCA_YEARS = 1;

/** Built once per set of list editions and reused for every screening. */
export type ScreeningIndex = {
  readonly entries: readonly SanctionsEntry[];
  readonly versions: readonly ListVersion[];
  readonly names: NameIndex;
  readonly identifierEntries: ReadonlyMap<string, readonly number[]>;
};

const identifierKey = (value: string): string =>
  value.toUpperCase().replaceAll(/[^\p{L}\p{N}]/gu, "");

function* screeningIndexSteps(
  lists: readonly ParsedList[],
): Generator<void, ScreeningIndex, void> {
  const entries = lists.flatMap((list) => list.entries);
  const identifierEntries = new Map<string, number[]>();
  for (const [entryIndex, entry] of entries.entries()) {
    for (const { number, status, kind } of entry.identifiers) {
      // A document the list itself marks as false is no proof of identity.
      if (status === "known-false" || kind === "unknown") {
        continue;
      }
      const key = identifierKey(number);
      if (key.length < MIN_IDENTIFIER_LENGTH) {
        continue;
      }
      const known = identifierEntries.get(key);
      if (known === undefined) {
        identifierEntries.set(key, [entryIndex]);
      } else if (!known.includes(entryIndex)) {
        known.push(entryIndex);
      }
    }
    yield;
  }
  return {
    entries,
    versions: lists.map((list) => list.version),
    names: yield* nameIndexSteps(entries),
    identifierEntries,
  };
}

export const buildScreeningIndex = (
  lists: readonly ParsedList[],
): ScreeningIndex => runSteps(screeningIndexSteps(lists));

/** A birth date as a registry or client record gives it. */
type QueryBirthDate = {
  year: number;
  month?: number;
  day?: number;
};

type FieldComparison = "match" | "mismatch" | "not-compared";

type BirthDateComparison =
  | "exact"
  | "approximate"
  | "mismatch"
  | "not-compared";

const birthDateMatch = (
  query: QueryBirthDate,
  listed: BirthDate,
): BirthDateComparison => {
  const tolerance = listed.circa ? CIRCA_YEARS : 0;
  const yearWithin = (from: number, to: number) =>
    query.year >= from - tolerance && query.year <= to + tolerance;
  const monthAgrees = (month: number) =>
    query.month === undefined || listed.circa || query.month === month;
  switch (listed.precision) {
    case "day":
      if (
        query.year === listed.year &&
        query.month === listed.month &&
        query.day === listed.day
      ) {
        return "exact";
      }
      // A full date that differs is another date unless the list hedges it.
      if (query.day !== undefined && !listed.circa) {
        return "mismatch";
      }
      return yearWithin(listed.year, listed.year) && monthAgrees(listed.month)
        ? "approximate"
        : "mismatch";
    case "month":
      return yearWithin(listed.year, listed.year) && monthAgrees(listed.month)
        ? "approximate"
        : "mismatch";
    case "month-day":
      if (query.month === undefined || query.day === undefined) {
        return "not-compared";
      }
      if (query.month === listed.month && query.day === listed.day) {
        return "approximate";
      }
      return listed.circa ? "not-compared" : "mismatch";
    case "year":
      return yearWithin(listed.year, listed.year) ? "approximate" : "mismatch";
    case "year-range":
      return yearWithin(
        listed.fromYear ?? Number.NEGATIVE_INFINITY,
        listed.toYear ?? Number.POSITIVE_INFINITY,
      )
        ? "approximate"
        : "mismatch";
    default: {
      listed satisfies never;
      return panic("unhandled birth date precision");
    }
  }
};

const compareBirthDates = (
  query: QueryBirthDate | undefined,
  listed: readonly BirthDate[],
): BirthDateComparison => {
  if (query === undefined || listed.length === 0) {
    return "not-compared";
  }
  const outcomes = new Set(listed.map((date) => birthDateMatch(query, date)));
  if (outcomes.has("exact")) {
    return "exact";
  }
  if (outcomes.has("approximate")) {
    return "approximate";
  }
  return outcomes.has("not-compared") ? "not-compared" : "mismatch";
};

export type ScreeningQuery = {
  name: string;
  nameSource?: "free-text" | "register";
  /** Omit when the kind of party is unknown. */
  entityType?: EntityType;
  birthDate?: QueryBirthDate;
  nationality?: readonly CountryCode[];
  /** Passport, national id, registration or tax numbers, in any formatting. */
  identifiers?: readonly string[];
};

/** Identity fields that can contradict a name match. */
type IdentityField = "birth-date" | "nationality" | "entity-type";

type MatchEvidence = {
  /** Name similarity before identity fields, 0..1. */
  nameScore: number;
  /** The listed name that scored best; null when only an identifier matched. */
  matchedName: string | null;
  birthDate: FieldComparison;
  nationality: FieldComparison;
  entityType: FieldComparison;
  identifier: FieldComparison;
  /** Fields that contradict the listing; non-empty only for mismatches. */
  conflicts: IdentityField[];
};

/**
 * A listed entry that resembles the query closely enough to need a human
 * decision. It is never a confirmed hit, whatever its score.
 */
type PossibleMatch = {
  entry: SanctionsEntry;
  /** 0..1; at or above the cutoff the result was screened with. */
  score: number;
  evidence: MatchEvidence;
};

export type ScreeningResult = {
  cutoff: number;
  /** The list editions the index was built from. */
  versions: readonly ListVersion[];
  /** The best `limit` of the entries at or above the cutoff. */
  possibleMatches: PossibleMatch[];
  /** Count found at or above the cutoff; a lower bound when candidate scoring is truncated. */
  totalMatches: number;
  truncated: boolean;
};

export class ScreeningQueryError extends TaggedError("ScreeningQueryError")<{
  code: "empty-query" | "invalid-birth-date" | "excess-query-tokens";
  message: string;
}> {}

export class ScreeningWorkLimitError extends TaggedError(
  "ScreeningWorkLimitError",
)<{
  code: "work-limit";
  message: string;
}> {}

const workLimit = () =>
  Result.err(
    new ScreeningWorkLimitError({
      code: "work-limit",
      message: "screening exceeded its work limit",
    }),
  );

type ScreenOptions = {
  /** Minimum score (0..1) for an entry to be reported as a possible match. */
  cutoff: number;
  limit?: number;
  /** Optional tighter budget; callers cannot exceed the global work bound. */
  maxWork?: number;
};

const validBirthDate = ({ year, month, day }: QueryBirthDate): boolean => {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    return false;
  }
  if (month === undefined) {
    return day === undefined;
  }
  return isCalendarDate({ year, month, day: day ?? 1 });
};

const moveToward = (score: number, share: number) =>
  score + (1 - score) * share;

const nationalityComparison = (
  query: readonly CountryCode[] | undefined,
  entry: SanctionsEntry,
): FieldComparison => {
  if (query === undefined || query.length === 0) {
    return "not-compared";
  }
  const known = entry.nationalities.flatMap((country) =>
    country.code === null ? [] : [country.code],
  );
  if (known.length === 0) {
    return "not-compared";
  }
  return query.some((country) => known.includes(country))
    ? "match"
    : "mismatch";
};

const entityTypeComparison = (
  query: EntityType | undefined,
  entry: SanctionsEntry,
): FieldComparison => {
  if (
    query === undefined ||
    query === "unknown" ||
    entry.entityType === "unknown"
  ) {
    return "not-compared";
  }
  return query === entry.entityType ? "match" : "mismatch";
};

type IdentifierComparisonInput = {
  query: ScreeningQuery;
  entry: SanctionsEntry;
  identifierMatch: boolean;
};

const identifierComparison = ({
  query,
  entry,
  identifierMatch,
}: IdentifierComparisonInput): FieldComparison => {
  if (
    query.identifiers === undefined ||
    query.identifiers.length === 0 ||
    !entry.identifiers.some(
      ({ status, kind }) => status === "listed" && kind !== "unknown",
    )
  ) {
    return "not-compared";
  }
  return identifierMatch ? "match" : "mismatch";
};

type EntryEvidenceInput = {
  cutoff: number;
  entry: SanctionsEntry;
  query: ScreeningQuery;
  nameScore: number;
  matchedName: string | null;
  identifierMatch: boolean;
};

type NameEvidenceScoreOptions = {
  cutoff: number;
  nameScore: number;
  birth: BirthDateComparison;
  nationality: FieldComparison;
  entityType: FieldComparison;
};

const scoreNameEvidence = ({
  cutoff,
  nameScore,
  birth,
  nationality,
  entityType,
}: NameEvidenceScoreOptions): number => {
  let score = nameScore;
  switch (birth) {
    case "exact":
      score = moveToward(score, BIRTH_DATE_EXACT_BOOST);
      break;
    case "approximate":
      score = moveToward(score, BIRTH_DATE_APPROXIMATE_BOOST);
      break;
    case "mismatch":
      score *= BIRTH_DATE_MISMATCH_FACTOR;
      break;
    case "not-compared":
      break;
    default: {
      birth satisfies never;
      panic("unhandled birth date comparison");
    }
  }
  if (nationality === "match") {
    score = moveToward(score, NATIONALITY_MATCH_BOOST);
  } else if (nationality === "mismatch") {
    score *= NATIONALITY_MISMATCH_FACTOR;
  }
  if (entityType === "mismatch") {
    score *= ENTITY_TYPE_MISMATCH_FACTOR;
  }
  if (
    (birth === "mismatch" ||
      nationality === "mismatch" ||
      entityType === "mismatch") &&
    nameScore >= STRONG_NAME_SCORE
  ) {
    score = Math.max(score, Math.min(cutoff, nameScore));
  }
  return score;
};

const scoreEntry = ({
  cutoff,
  entry,
  query,
  nameScore,
  matchedName,
  identifierMatch,
}: EntryEvidenceInput): PossibleMatch => {
  const birth = compareBirthDates(query.birthDate, entry.birthDates);
  const nationality = nationalityComparison(query.nationality, entry);
  const entityType = entityTypeComparison(query.entityType, entry);
  const identifier = identifierComparison({ query, entry, identifierMatch });

  let score = scoreNameEvidence({
    cutoff,
    nameScore,
    birth,
    nationality,
    entityType,
  });
  const birthDate =
    birth === "exact" || birth === "approximate" ? "match" : birth;
  const conflicts = (
    [
      ["birth-date", birthDate],
      ["nationality", nationality],
      ["entity-type", entityType],
    ] as const
  ).flatMap(([field, comparison]) =>
    comparison === "mismatch" ? [field] : [],
  );
  // A shared document number identifies the entry regardless of the name.
  if (identifier === "match") {
    score = 1;
  }
  return {
    entry,
    score,
    evidence: {
      nameScore,
      matchedName,
      birthDate,
      nationality,
      entityType,
      identifier,
      conflicts,
    },
  };
};

type ScreenNameReadingsOptions = {
  index: NameIndex;
  readings: readonly NameReading[];
  ceiling: (queryShare: number) => number;
  rankEntry: (entry: number, nameScore: number) => number | undefined;
  cutoff: number;
  work: ScreeningWorkBudget;
};

// Both interpretations of an unknown party share a budget and their best evidence.
const screenNameReadings = ({
  index,
  readings,
  ceiling,
  rankEntry,
  cutoff,
  work,
}: ScreenNameReadingsOptions): Result<NameMatches, ScreeningWorkLimitError> => {
  const nameMatches = new Map<number, NameMatch>();
  let truncated = false;
  const distinctReadings = new Map(
    readings.map((reading) => [
      `${reading.tokens.map((token) => token.raw).join(" ")}|${reading.adjacent.join(";")}`,
      reading,
    ]),
  );
  for (const reading of distinctReadings.values()) {
    if (reading.tokens.length === 0) {
      continue;
    }
    const matched = matchNames({
      index,
      reading,
      ceiling,
      rankEntry,
      cutoff,
      work,
    });
    if (matched === undefined) {
      return workLimit();
    }
    truncated ||= matched.truncated;
    for (const [entryIndex, match] of matched.matches) {
      const known = nameMatches.get(entryIndex);
      if (known === undefined || match.score > known.score) {
        nameMatches.set(entryIndex, match);
      }
    }
  }
  return Result.ok({ matches: nameMatches, truncated });
};

type PreparedScreeningQuery = {
  readings: NameReading[];
  identifierKeys: Set<string>;
};
type PreparedScreeningQueryResult = Result<
  PreparedScreeningQuery,
  ScreeningQueryError
>;

const prepareScreeningQuery = (
  query: ScreeningQuery,
): PreparedScreeningQueryResult => {
  if (query.birthDate !== undefined && !validBirthDate(query.birthDate)) {
    return Result.err(
      new ScreeningQueryError({
        code: "invalid-birth-date",
        message: "the birth date is not a valid calendar date",
      }),
    );
  }
  // An unknown party is read both ways: as an organisation, with legal forms
  // stripped, and as a person, whose "Ag" or "Sa" may be part of the name.
  const kinds =
    query.entityType === undefined
      ? (["organisation", "person"] as const)
      : [query.entityType];
  if (
    query.nameSource !== "register" &&
    kinds.some((kind) => hasExcessQueryTokens(query.name, kind))
  ) {
    return Result.err(
      new ScreeningQueryError({
        code: "excess-query-tokens",
        message: `the name must contain at most ${MAX_QUERY_TOKENS} normalized tokens`,
      }),
    );
  }
  const readings = kinds.map((kind) => nameReading(query.name, kind));
  const tokens = readings.at(0)?.tokens ?? [];
  const identifierKeys = new Set(
    (query.identifiers ?? [])
      .map(identifierKey)
      .filter((key) => key.length >= MIN_IDENTIFIER_LENGTH),
  );
  if (tokens.length === 0 && identifierKeys.size === 0) {
    return Result.err(
      new ScreeningQueryError({
        code: "empty-query",
        message: "the query has no name letters and no usable identifier",
      }),
    );
  }

  return Result.ok({ readings, identifierKeys });
};

/**
 * Screens one party against the index and returns every entry scoring at or
 * above `cutoff`, best first. Each result is a possible match for review.
 */
export const screen = (
  index: ScreeningIndex,
  query: ScreeningQuery,
  {
    cutoff,
    limit = DEFAULT_LIMIT,
    maxWork = MAX_SCREENING_WORK,
  }: ScreenOptions,
): Result<ScreeningResult, ScreeningQueryError | ScreeningWorkLimitError> => {
  if (!(cutoff >= 0 && cutoff <= 1)) {
    panic(`cutoff must be within 0..1, got ${cutoff}`);
  }
  if (!Number.isInteger(limit) || limit < 1) {
    panic(`limit must be a positive integer, got ${limit}`);
  }
  if (
    !Number.isInteger(maxWork) ||
    maxWork < 1 ||
    maxWork > MAX_SCREENING_WORK
  ) {
    panic(`maxWork must be within 1..${MAX_SCREENING_WORK}, got ${maxWork}`);
  }
  const prepared = prepareScreeningQuery(query);
  if (prepared.isErr()) {
    return prepared;
  }
  const { readings, identifierKeys } = prepared.value;

  // The best final score a name could reach if every identity field matched,
  // given the share of the query it explains; the geometric mean with the
  // listed side's share is at most the square root.
  const ceiling = (queryShare: number) => {
    let score = Math.sqrt(queryShare);
    if (query.birthDate !== undefined) {
      score = moveToward(score, BIRTH_DATE_EXACT_BOOST);
    }
    if (query.nationality !== undefined && query.nationality.length > 0) {
      score = moveToward(score, NATIONALITY_MATCH_BOOST);
    }
    return score;
  };
  const work = {
    remaining: maxWork,
    exhausted: false,
    selection: "complete" as const,
  };
  const matched = screenNameReadings({
    index: index.names,
    readings,
    ceiling,
    rankEntry: (entryIndex, nameScore) => {
      const entry = index.entries[entryIndex] ?? panic("Missing ranked entry");
      if (
        !spendScreeningWork(
          work,
          entry.birthDates.length +
            entry.nationalities.length +
            entry.identifiers.length +
            1,
        )
      ) {
        return undefined;
      }
      return scoreNameEvidence({
        cutoff,
        nameScore,
        birth: compareBirthDates(query.birthDate, entry.birthDates),
        nationality: nationalityComparison(query.nationality, entry),
        entityType: entityTypeComparison(query.entityType, entry),
      });
    },
    cutoff,
    work,
  });
  if (matched.isErr()) {
    return matched;
  }
  const nameMatches = matched.value.matches;
  const identifierMatches = new Set<number>();
  for (const key of identifierKeys) {
    for (const entryIndex of index.identifierEntries.get(key) ?? []) {
      if (!spendScreeningWork(work)) {
        return workLimit();
      }
      identifierMatches.add(entryIndex);
    }
  }

  const possibleMatches: PossibleMatch[] = [];
  for (const entryIndex of new Set([
    ...nameMatches.keys(),
    ...identifierMatches,
  ])) {
    const entry = index.entries[entryIndex];
    if (entry === undefined) {
      continue;
    }
    const cost =
      entry.birthDates.length +
      entry.nationalities.length +
      entry.identifiers.length +
      1;
    if (!spendScreeningWork(work, cost)) {
      return workLimit();
    }
    const best = nameMatches.get(entryIndex);
    const match = scoreEntry({
      cutoff,
      entry,
      query,
      nameScore: best?.score ?? 0,
      matchedName: best?.name ?? null,
      identifierMatch: identifierMatches.has(entryIndex),
    });
    if (match.score >= cutoff) {
      possibleMatches.push(match);
    }
  }
  const sortingWork =
    possibleMatches.length * Math.ceil(Math.log2(possibleMatches.length + 1));
  if (!spendScreeningWork(work, sortingWork)) {
    return workLimit();
  }
  possibleMatches.sort(
    (left, right) =>
      right.score - left.score ||
      left.entry.source.localeCompare(right.entry.source) ||
      left.entry.sourceId.localeCompare(right.entry.sourceId),
  );
  return Result.ok({
    cutoff,
    versions: index.versions,
    possibleMatches: possibleMatches.slice(0, limit),
    totalMatches: possibleMatches.length,
    truncated: matched.value.truncated || possibleMatches.length > limit,
  });
};
