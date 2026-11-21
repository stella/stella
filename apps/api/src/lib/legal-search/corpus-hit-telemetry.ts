import { panic } from "better-result";

import { logger } from "@/api/lib/observability/logger";

export type CorpusHitDispositionCounts = {
  malformed: number;
  excluded: number;
  drift: number;
};

/** One accumulator shared by the scan, highlighting and canonical reads. */
export const createCorpusHitDispositionCounter = () => {
  const counts = { malformed: 0, excluded: 0, drift: 0 };
  const accountedCanonicalIds = new Set<string>();
  return {
    record: ({
      malformed = 0,
    }: Partial<Pick<CorpusHitDispositionCounts, "malformed">>): void => {
      counts.malformed += malformed;
    },
    // The first omission owns the count even if a later read changes its kind.
    recordCanonical: ({
      id,
      type: dispositionType,
    }: {
      id: string;
      type: "excluded" | "drift";
    }): void => {
      if (accountedCanonicalIds.has(id)) {
        return;
      }
      accountedCanonicalIds.add(id);
      switch (dispositionType) {
        case "excluded":
          counts.excluded += 1;
          break;
        case "drift":
          counts.drift += 1;
          break;
        default:
          dispositionType satisfies never;
          panic("Unhandled canonical rehydration disposition");
      }
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
