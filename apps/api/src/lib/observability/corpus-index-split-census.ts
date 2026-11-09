import { Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexClusterForGeneration,
  type QuickwitCluster,
} from "@/api/lib/legal-search/corpus-generation-contract";
import {
  type CorpusIndexPublishedSplitCount,
  getCorpusIndexClient,
  readCorpusIndexSearchBaseUrl,
} from "@/api/lib/legal-search/corpus-index-client";
import { readServedCorpusIndexGenerationsTx } from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import { tryCorpusIndexGeneration } from "@/api/lib/legal-search/index-naming";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";

/**
 * Hourly record of how many published splits each served corpus index holds.
 *
 * Merges happen only between splits of one node id, so an index can collect
 * hundreds of tiny splits while its document count and size look healthy, and
 * every search then opens all of them. The record carries the highest count
 * as a single number so one metric and one alarm cover every served index;
 * `splitsByIndex` says which one it was.
 */
type ServedGeneration = { generation: string; cluster: QuickwitCluster };

const SPLIT_CENSUS_SINK = failureSink({
  event: "corpus_index.split_census_failed",
  expected: [],
});

export const readServedGenerationsForCensusTx = async (
  tx: Transaction,
): Promise<ServedGeneration[]> => {
  const [caseLaw, legislation] = await Promise.all([
    readServedCorpusIndexGenerationsTx(tx, "case_law"),
    readServedCorpusIndexGenerationsTx(tx, "legislation"),
  ]);
  const reads = [
    { family: "case_law", served: caseLaw },
    { family: "legislation", served: legislation },
  ] as const;
  return reads.flatMap(({ family, served }) => {
    // A family with nothing served has nothing to count.
    if (Result.isError(served)) {
      return [];
    }
    const { serving, flipped } = served.value;
    return [
      ...new Set([
        serving.generation,
        ...flipped.map(([, generation]) => generation),
      ]),
    ].map((generation) => ({
      generation,
      cluster: corpusIndexClusterForGeneration(family, generation),
    }));
  });
};

export const splitCensusAttributes = (
  counts: readonly CorpusIndexPublishedSplitCount[],
) => ({
  maxPublishedSplits: Math.max(
    0,
    ...counts.map(({ publishedSplits }) => publishedSplits),
  ),
  servingIndexes: counts.length,
  splitsByIndex: counts
    .map(({ indexId, publishedSplits }) => `${indexId}=${publishedSplits}`)
    .join(","),
});

/** Telemetry only: a failed read is logged and never fails the report. */
export const reportCorpusIndexSplitCensus = async (
  generations: readonly ServedGeneration[],
): Promise<void> => {
  const clusters = [...new Set(generations.map(({ cluster }) => cluster))];
  const counts: CorpusIndexPublishedSplitCount[] = [];
  for (const cluster of clusters) {
    // A deployment without a corpus index has no splits to count.
    if (readCorpusIndexSearchBaseUrl(cluster) === null) {
      continue;
    }
    const served = new Set(
      generations
        .filter((generation) => generation.cluster === cluster)
        .map(({ generation }) => generation),
    );
    const read = await getCorpusIndexClient(cluster).readPublishedSplitCounts({
      includes: (indexId) => {
        const generation = tryCorpusIndexGeneration(indexId);
        return generation !== null && served.has(generation);
      },
      observer: "unobserved",
    });
    if (Result.isError(read)) {
      observeFailure(read.error, { sink: SPLIT_CENSUS_SINK });
      return;
    }
    counts.push(...read.value);
  }
  if (counts.length > 0) {
    logger.info("corpus_index.split_census", splitCensusAttributes(counts));
  }
};
