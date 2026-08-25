import { envBase } from "@/api/env-base";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";

export {
  CORPUS_FAMILIES,
  parseCorpusFamily,
} from "@/api/lib/legal-search/corpus-generation-contract";
export type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";

/**
 * Blue-green generation prefix per family. Index ids are
 * `<generation>_<jurisdiction>` (e.g. `case_law_v1_svk`,
 * `legislation_v1_svk`), or `<generation>_<group>` for case-law generations
 * from 3 on (`corpusIndexId`). Bumping a prefix rebuilds that family across
 * all jurisdictions, then you flip to it. case_law keeps its existing env
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
