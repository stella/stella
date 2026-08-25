import { Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type {
  CorpusIndexClient,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  readAppliedCorpusProjectionCensusPageTx,
  readSettledCorpusProjectionCensusPageTx,
} from "@/api/lib/legal-search/corpus-index-projection-census-store";
import { censusCorpusProjectionRevisions } from "@/api/lib/legal-search/corpus-index-projection-engine";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;

type CorpusProjectionCensusOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: Pick<CorpusIndexClient, "aggregate">;
  family: CorpusFamily;
  generation: string;
  indexId: string;
  after: string | null;
  limit: number;
};

type CorpusProjectionCensusResult = {
  expected: "present" | "absent";
  inspected: number;
  driftRevisions: string[];
  nextCursor: string | null;
  complete: boolean;
};

/**
 * Inspect one bounded final-projection census page. Plane owns the durable
 * cursor and cadence; this public primitive owns the PG-authoritative set and
 * rejects approximate engine results.
 */
export const censusAppliedCorpusProjections = async ({
  runInTransaction,
  client,
  family,
  generation,
  indexId,
  after,
  limit,
}: CorpusProjectionCensusOptions): Promise<
  Result<CorpusProjectionCensusResult, CorpusIndexError>
> => {
  const page = await runInTransaction(
    async (tx) =>
      await readAppliedCorpusProjectionCensusPageTx(tx, {
        family,
        generation,
        indexId,
        after,
        limit,
      }),
  );
  if (page.candidates.length === 0) {
    return Result.ok({
      expected: "present",
      inspected: 0,
      driftRevisions: [],
      nextCursor: null,
      complete: true,
    } satisfies CorpusProjectionCensusResult);
  }
  const census = await censusCorpusProjectionRevisions({
    client,
    indexId,
    revisions: page.candidates.map(({ revision }) => revision),
  });
  return census.map(
    ({ missing }) =>
      ({
        expected: "present",
        inspected: page.candidates.length,
        driftRevisions: missing,
        nextCursor: page.nextCursor,
        complete: page.complete,
      }) satisfies CorpusProjectionCensusResult,
  );
};

/** Exact settled revisions observed again are durable orphan-index drift. */
export const censusSettledCorpusProjections = async ({
  runInTransaction,
  client,
  family,
  generation,
  indexId,
  after,
  limit,
}: CorpusProjectionCensusOptions): Promise<
  Result<CorpusProjectionCensusResult, CorpusIndexError>
> => {
  const page = await runInTransaction(
    async (tx) =>
      await readSettledCorpusProjectionCensusPageTx(tx, {
        family,
        generation,
        indexId,
        after,
        limit,
      }),
  );
  if (page.candidates.length === 0) {
    return Result.ok({
      expected: "absent",
      inspected: 0,
      driftRevisions: [],
      nextCursor: null,
      complete: true,
    } satisfies CorpusProjectionCensusResult);
  }
  const census = await censusCorpusProjectionRevisions({
    client,
    indexId,
    revisions: page.candidates.map(({ revision }) => revision),
  });
  return census.map(
    ({ present }) =>
      ({
        expected: "absent",
        inspected: page.candidates.length,
        driftRevisions: present.map(({ revision }) => revision),
        nextCursor: page.nextCursor,
        complete: page.complete,
      }) satisfies CorpusProjectionCensusResult,
  );
};
