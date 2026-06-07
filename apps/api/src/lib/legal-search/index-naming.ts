import { panic } from "better-result";

/**
 * Quickwit index naming, generic over document family. The `generation`
 * is a family-scoped blue-green prefix (`case_law_v1`, `legislation_v1`),
 * and each jurisdiction gets its own physical index
 * (`<generation>_<jurisdiction>`, e.g. `case_law_v1_svk`). So reindex,
 * retention, and query scope are isolated per family AND per jurisdiction,
 * and a scoped query only touches that one index. A single shared
 * searcher pool serves them all (Quickwit routes splits to searchers by
 * consistent hashing) — index-level isolation, not per-family compute.
 */

// Quickwit index ids must match ^[a-zA-Z][a-zA-Z0-9._-]{2,254}$. The
// jurisdiction segment comes from the trusted `country` column (always
// alpha), but we guard so a malformed value can't craft an odd id.
const JURISDICTION_PATTERN = /^[a-z]{2,8}$/u;

export const corpusIndexId = (
  generation: string,
  jurisdiction: string,
): string => {
  const jur = jurisdiction.toLowerCase();
  if (!JURISDICTION_PATTERN.test(jur)) {
    panic(`Invalid jurisdiction for Quickwit index id: ${jurisdiction}`);
  }
  return `${generation}_${jur}`;
};

/** Glob matching every jurisdiction index for a generation (multi-index search). */
export const corpusIndexPattern = (generation: string): string =>
  `${generation}_*`;
