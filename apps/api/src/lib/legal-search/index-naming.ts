import { panic } from "better-result";

import {
  CASE_LAW_INDEX_GROUP_NAMES,
  CASE_LAW_INDEX_GROUPING_FROM_GENERATION,
  caseLawIndexGroup,
  caseLawIndexGroupCountries,
  isCaseLawIndexGroup,
  POSTGRES_INTEGER_MAX,
} from "@/api/lib/legal-search/case-law-index-groups";
import { CORPUS_INDEX_GENERATION_MAX_LENGTH } from "@/api/lib/legal-search/corpus-generation-contract";

/**
 * corpus index index naming, generic over document family. The `generation`
 * is a family-scoped blue-green prefix (`case_law_v1`, `legislation_v1`).
 * The physical index is `<generation>_<jurisdiction>` (e.g. `case_law_v1_svk`),
 * except that case-law generations from
 * `CASE_LAW_INDEX_GROUPING_FROM_GENERATION` on use `<generation>_<group>`
 * (e.g. `case_law_v3_cs_sk`), where the group is the jurisdiction's entry in
 * `CASE_LAW_INDEX_GROUP_OF`. So reindex, retention, and query scope are
 * isolated per family AND per index, and a scoped query only touches that
 * one index. A single shared searcher pool serves them all (corpus index
 * routes splits to searchers by consistent hashing) — index-level isolation,
 * not per-family compute.
 */

// Corpus index ids must match ^[a-zA-Z][a-zA-Z0-9._-]{2,254}$. Database
// columns use the tighter bound below so every constructed physical id has
// one storage contract across decisions, audit rows, and projection state.
export { CORPUS_INDEX_GENERATION_MAX_LENGTH };
export const CORPUS_INDEX_ID_MAX_LENGTH = 64;

const GENERATION_PATTERN = new RegExp(
  `^[a-zA-Z][a-zA-Z0-9._-]{0,${CORPUS_INDEX_GENERATION_MAX_LENGTH - 1}}$`,
  "u",
);

export const isCorpusIndexGeneration = (value: string): boolean =>
  GENERATION_PATTERN.test(value);

const CASE_LAW_CORPUS_GENERATION_PATTERN = /^case_law_v([1-9][0-9]*)$/u;

/** Numeric precedence for the one canonical case-law generation form. */
export const caseLawCorpusGenerationOrder = (value: string): number | null => {
  if (!isCorpusIndexGeneration(value)) {
    return null;
  }
  const version = CASE_LAW_CORPUS_GENERATION_PATTERN.exec(value)?.at(1);
  if (version === undefined) {
    return null;
  }
  const order = Number(version);
  return Number.isSafeInteger(order) && order <= POSTGRES_INTEGER_MAX
    ? order
    : null;
};

export const isCaseLawCorpusGeneration = (value: string): boolean =>
  caseLawCorpusGenerationOrder(value) !== null;

/** Whether this generation's case-law indexes are per group, not per country. */
const isGroupedCaseLawGeneration = (generation: string): boolean => {
  const order = caseLawCorpusGenerationOrder(generation);
  return order !== null && order >= CASE_LAW_INDEX_GROUPING_FROM_GENERATION;
};

// The jurisdiction segment comes from the trusted `country` column (always
// alpha), but we guard so a malformed value cannot craft an odd id.
const JURISDICTION_PATTERN = /^[a-z]{2,8}$/u;

export const isCorpusIndexJurisdiction = (value: string): boolean =>
  JURISDICTION_PATTERN.test(value.toLowerCase());

export const corpusIndexId = (
  generation: string,
  jurisdiction: string,
): string => {
  if (!isCorpusIndexGeneration(generation)) {
    panic(`Invalid corpus index generation: ${generation}`);
  }
  const jur = jurisdiction.toLowerCase();
  if (!isCorpusIndexJurisdiction(jur)) {
    panic(`Invalid jurisdiction for corpus index index id: ${jurisdiction}`);
  }
  const suffix = isGroupedCaseLawGeneration(generation)
    ? caseLawIndexGroup(jur)
    : jur;
  const indexId = `${generation}_${suffix}`;
  if (indexId.length > CORPUS_INDEX_ID_MAX_LENGTH) {
    panic(`Corpus index id exceeds storage limit: ${indexId}`);
  }
  return indexId;
};

/** Distinct physical index ids the jurisdictions map to, in first-seen order. */
export const corpusIndexIdsFor = (
  generation: string,
  jurisdictions: readonly string[],
): string[] => [
  ...new Set(
    jurisdictions.map((jurisdiction) =>
      corpusIndexId(generation, jurisdiction),
    ),
  ),
];

/**
 * Jurisdictions whose rows `corpusIndexId` places in this physical index of
 * this generation, in canonical (uppercase) form: the inverse of
 * `corpusIndexId`, so a predicate over `country` can address exactly the
 * rows an index answers for.
 */
export const corpusIndexJurisdictions = (
  generation: string,
  indexId: string,
): readonly string[] => {
  const prefix = `${generation}_`;
  if (!indexId.startsWith(prefix)) {
    panic(`Corpus index id ${indexId} is not of generation ${generation}`);
  }
  const suffix = indexId.slice(prefix.length);
  if (isGroupedCaseLawGeneration(generation) && isCaseLawIndexGroup(suffix)) {
    return caseLawIndexGroupCountries(suffix);
  }
  if (!isCorpusIndexJurisdiction(suffix)) {
    panic(`Invalid corpus index index id: ${indexId}`);
  }
  return [suffix.toUpperCase()];
};

/**
 * Whether the physical index a scoped query selects for this jurisdiction
 * also holds other jurisdictions, so the query needs a jurisdiction clause
 * of its own to stay exact.
 */
const corpusIndexHoldsOtherJurisdictions = (
  generation: string,
  jurisdiction: string,
): boolean =>
  isGroupedCaseLawGeneration(generation) &&
  caseLawIndexGroupCountries(caseLawIndexGroup(jurisdiction)).length > 1;

export type CorpusIndexRoute = {
  /** Physical index, or the generation glob when the query is unscoped. */
  indexId: string;
  /**
   * Jurisdiction the engine query must carry as a clause, in the canonical
   * uppercase form indexed documents carry: the scoped one when its physical
   * index holds other jurisdictions, otherwise undefined because the index
   * itself already bounds the query.
   */
  jurisdictionClause: string | undefined;
};

/** Index selection for a query, scoped to one jurisdiction or unscoped. */
export const corpusIndexRoute = (
  generation: string,
  jurisdiction: string | undefined,
): CorpusIndexRoute => {
  if (jurisdiction === undefined) {
    return {
      indexId: corpusIndexPattern(generation),
      jurisdictionClause: undefined,
    };
  }
  const canonical = jurisdiction.toUpperCase();
  return {
    indexId: corpusIndexId(generation, canonical),
    jurisdictionClause: corpusIndexHoldsOtherJurisdictions(
      generation,
      canonical,
    )
      ? canonical
      : undefined,
  };
};

/**
 * Recovers the generation prefix from a validated physical index id.
 *
 * A grouped case-law id ends in a group name, which may itself contain the
 * separator (`case_law_v3_cs_sk`), so those suffixes are tried first; every
 * other id ends in a single jurisdiction segment.
 */
export const tryCorpusIndexGeneration = (indexId: string): string | null => {
  for (const group of CASE_LAW_INDEX_GROUP_NAMES) {
    const suffix = `_${group}`;
    if (!indexId.endsWith(suffix)) {
      continue;
    }
    const generation = indexId.slice(0, -suffix.length);
    if (isGroupedCaseLawGeneration(generation)) {
      return generation;
    }
  }
  const separator = indexId.lastIndexOf("_");
  const generation = indexId.slice(0, separator);
  const jurisdiction = indexId.slice(separator + 1);
  if (
    separator <= 0 ||
    !isCorpusIndexGeneration(generation) ||
    !isCorpusIndexJurisdiction(jurisdiction)
  ) {
    return null;
  }
  return generation;
};

/** Recovers the generation prefix where malformed state is impossible. */
export const corpusIndexGeneration = (indexId: string): string => {
  const generation = tryCorpusIndexGeneration(indexId);
  if (generation === null) {
    panic(`Invalid corpus index index id: ${indexId}`);
  }
  return generation;
};

/** Glob matching every index of a generation (multi-index search). */
export const corpusIndexPattern = (generation: string): string => {
  if (!isCorpusIndexGeneration(generation)) {
    panic(`Invalid corpus index generation: ${generation}`);
  }
  return `${generation}_*`;
};
