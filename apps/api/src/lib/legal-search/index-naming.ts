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

// corpus index index ids must match ^[a-zA-Z][a-zA-Z0-9._-]{2,254}$. The
// jurisdiction segment comes from the trusted `country` column (always
// alpha), but we guard so a malformed value can't craft an odd id.
const JURISDICTION_PATTERN = /^[a-z]{2,8}$/u;

export const isCorpusIndexJurisdiction = (value: string): boolean =>
  JURISDICTION_PATTERN.test(value.toLowerCase());

export const corpusIndexId = (
  generation: string,
  jurisdiction: string,
): string => {
  const jur = jurisdiction.toLowerCase();
  if (!isCorpusIndexJurisdiction(jur)) {
    panic(`Invalid jurisdiction for corpus index index id: ${jurisdiction}`);
  }
  return `${generation}_${jur}`;
};

/** Recovers the generation prefix from a validated physical index id. */
export const tryCorpusIndexGeneration = (indexId: string): string | null => {
  const separator = indexId.lastIndexOf("_");
  const generation = indexId.slice(0, separator);
  const jurisdiction = indexId.slice(separator + 1);
  if (
    separator <= 0 ||
    generation.length === 0 ||
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
export const corpusIndexPattern = (generation: string): string =>
  `${generation}_*`;
