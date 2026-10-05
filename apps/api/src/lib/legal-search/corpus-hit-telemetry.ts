import { logger } from "@/api/lib/observability/logger";

type CorpusHitDispositionCounts = {
  stage: "rehydration" | "native" | "bm25" | "highlight" | "scored";
  family?: "case_law" | "legislation" | undefined;
  malformed?: number | undefined;
  excluded?: number | undefined;
  drift?: number | undefined;
};

export const reportCorpusHitDispositions = ({
  stage,
  family,
  malformed = 0,
  excluded = 0,
  drift = 0,
}: CorpusHitDispositionCounts): void => {
  if (malformed + excluded + drift === 0) {
    return;
  }
  logger.warn("corpus.search.hit_dispositions", {
    stage,
    ...(family === undefined ? {} : { family }),
    malformed,
    excluded,
    drift,
  });
};
