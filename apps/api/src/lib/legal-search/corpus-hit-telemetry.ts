import { logger } from "@/api/lib/observability/logger";

export type CorpusHitDispositionCounts = {
  malformed: number;
  excluded: number;
  drift: number;
};

/** One accumulator shared by the scan, highlighting and canonical reads. */
export const createCorpusHitDispositionCounter = () => {
  const counts = { malformed: 0, excluded: 0, drift: 0 };
  return {
    record: ({
      malformed = 0,
      excluded = 0,
      drift = 0,
    }: Partial<CorpusHitDispositionCounts>): void => {
      counts.malformed += malformed;
      counts.excluded += excluded;
      counts.drift += drift;
    },
    snapshot: () => ({ ...counts }),
  };
};

export type CorpusHitDispositionCounter = ReturnType<
  typeof createCorpusHitDispositionCounter
>;

type ReportCorpusHitDispositionsOptions = {
  family?: "case_law" | "legislation" | undefined;
  counts: CorpusHitDispositionCounts;
};

/** For search callers without an existing completed-request observation. */
export const reportCorpusHitDispositions = ({
  family,
  counts,
}: ReportCorpusHitDispositionsOptions): void => {
  if (counts.malformed + counts.excluded + counts.drift === 0) {
    return;
  }
  logger.info("corpus.search.hit_dispositions", {
    ...(family === undefined ? {} : { family }),
    ...counts,
  });
};
