import { panic } from "better-result";

/**
 * corpus index index naming, generic over document family. The `generation`
 * is a family-scoped blue-green prefix (`case_law_v1`, `legislation_v1`),
 * and each jurisdiction gets its own physical index
 * (`<generation>_<jurisdiction>`, e.g. `case_law_v1_svk`). So reindex,
 * retention, and query scope are isolated per family AND per jurisdiction,
 * and a scoped query only touches that one index. A single shared
 * searcher pool serves them all (corpus index routes splits to searchers by
 * consistent hashing) — index-level isolation, not per-family compute.
 */

// Corpus index ids must match ^[a-zA-Z][a-zA-Z0-9._-]{2,254}$. Database
// columns use the tighter bound below so every constructed physical id has
// one storage contract across decisions, audit rows, and projection state.
export const CORPUS_INDEX_GENERATION_MAX_LENGTH = 32;
export const CORPUS_INDEX_ID_MAX_LENGTH = 64;

const GENERATION_PATTERN = new RegExp(
  `^[a-zA-Z][a-zA-Z0-9._-]{0,${CORPUS_INDEX_GENERATION_MAX_LENGTH - 1}}$`,
  "u",
);

export const isCorpusIndexGeneration = (value: string): boolean =>
  GENERATION_PATTERN.test(value);

const CASE_LAW_CORPUS_GENERATION_PATTERN = /^case_law_v([1-9][0-9]*)$/u;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

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
  const indexId = `${generation}_${jur}`;
  if (indexId.length > CORPUS_INDEX_ID_MAX_LENGTH) {
    panic(`Corpus index id exceeds storage limit: ${indexId}`);
  }
  return indexId;
};

/** Recovers the generation prefix from a validated physical index id. */
export const tryCorpusIndexGeneration = (indexId: string): string | null => {
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

/** Glob matching every jurisdiction index for a generation (multi-index search). */
export const corpusIndexPattern = (generation: string): string => {
  if (!isCorpusIndexGeneration(generation)) {
    panic(`Invalid corpus index generation: ${generation}`);
  }
  return `${generation}_*`;
};
