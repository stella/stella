import { envBase } from "@/api/env-base";

/**
 * Document families served by the corpus / corpus index DB. The search,
 * index, storage, and rerank substrate is generic over these; each
 * family differs only in its index field mappings (below) and its
 * ingestion source (a per-family slice). Adding "gazette", "regulation",
 * etc. is: extend this union + register an index field spec + a doc
 * source — not a re-architecture.
 */
export const CORPUS_FAMILIES = ["case_law", "legislation"] as const;
export type CorpusFamily = (typeof CORPUS_FAMILIES)[number];

export const parseCorpusFamily = (value: unknown): CorpusFamily | null =>
  CORPUS_FAMILIES.find((family) => family === value) ?? null;

/**
 * Blue-green generation prefix per family. Index ids are
 * `<generation>_<jurisdiction>` (e.g. `case_law_v1_svk`,
 * `legislation_v1_svk`). Bumping a prefix rebuilds that family across all
 * jurisdictions, then you flip to it. case_law keeps its existing env
 * override for back-compat; other families default to `<family>_v1`.
 */
export const corpusGeneration = (family: CorpusFamily): string => {
  switch (family) {
    case "case_law":
      return envBase.LEGAL_SEARCH_INDEX_GENERATION;
    case "legislation":
      return "legislation_v1";
    default:
      return family satisfies never;
  }
};
