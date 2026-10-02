// parser-output-unchanged: Search ranking flag and policy; ingestion parsers never read them.
import { createHash } from "node:crypto";

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
    : createHash("sha256")
        .update(
          JSON.stringify([
            target,
            mode,
            CORPUS_BM25_PASSAGE_LIMIT,
            CORPUS_BM25_RATIO_POWER,
          ]),
        )
        .digest("hex")
        .slice(0, 32);
