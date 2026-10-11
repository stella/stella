// parser-output-unchanged: SHA-256 owner preserves the UTF-8 JSON cursor identity, hexadecimal encoding and 32-character prefix; pinned vectors cover equality.
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
// parser-output-unchanged: Search ranking flag and policy; ingestion parsers never read them.

import type { SearchSort } from "@/api/lib/legal-search/corpus-search-order";

export const CORPUS_INDEX_RANKING_MODES = ["off", "bm25-ratio"] as const;

export type CorpusIndexRankingMode =
  (typeof CORPUS_INDEX_RANKING_MODES)[number];

// Experimental recall candidate; its request latency must be measured before
// enabling it. One projected read stays below the engine's 10,000 offset cap.
export const CORPUS_BM25_PASSAGE_LIMIT = 7000;
export const CORPUS_BM25_RATIO_POWER = 0.25;

export const corpusRankingCursorTarget = (
  target: string | null,
  mode: CorpusIndexRankingMode,
): string | null =>
  mode === "off"
    ? target
    : hashSha256Hex(
        JSON.stringify([
          target,
          mode,
          CORPUS_BM25_PASSAGE_LIMIT,
          CORPUS_BM25_RATIO_POWER,
        ]),
      ).slice(0, 32);

type CorpusQueryRankingModeOptions = {
  configuredMode: CorpusIndexRankingMode;
  sort: SearchSort;
  textTokenCount: number;
};

export const corpusQueryRankingMode = ({
  configuredMode,
  sort,
  textTokenCount,
}: CorpusQueryRankingModeOptions): CorpusIndexRankingMode =>
  sort === "relevance" && textTokenCount > 0 ? configuredMode : "off";
