import { corpusIndexClusterForGeneration } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  getCorpusIndexClient,
  type CorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";

/**
 * Golden queries are case-law queries, so each generation resolves through
 * the case-law generation contract before selecting its Quickwit client.
 */
export const corpusIndexQueryDiffClientForGeneration = (
  generation: string,
): CorpusIndexClient =>
  getCorpusIndexClient(corpusIndexClusterForGeneration("case_law", generation));
