import { panic, Result } from "better-result";

import { chunk as chunkItems } from "@stll/concurrency/chunk";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type {
  CorpusIndexClient,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  proveCorpusProjectionRevisionsPresent,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  type AcceptedCorpusProjectionAppendProof,
  type CorpusProjectionProofTiming,
  proveAcceptedCorpusProjectionAppendsTx,
  readProvableCorpusProjectionAppendsTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;

const PROOF_CYCLE_TIMING = {
  type: "after_barrier",
} as const satisfies CorpusProjectionProofTiming;

type AcceptedProjectionRevision = {
  revision: SafeId<"corpusIndexProjectionIntent">;
  /** Documents its accepted append wrote. */
  documentCount: number;
};

type ProveAcceptedCorpusProjectionRevisionsOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: Pick<CorpusIndexClient, "aggregate">;
  indexId: string;
  accepted: readonly AcceptedProjectionRevision[];
  testNow?: Date | undefined;
};

/**
 * Prove committed revisions of one index: one exact census per aggregate-sized
 * chunk, outside any transaction, then one transaction acting on that census.
 * Every write is a compare-and-set on `append_committed`, so a prover that
 * dies between a census and its transaction has written nothing, and the next
 * pass censuses again.
 */
const proveAcceptedCorpusProjectionRevisions = async ({
  runInTransaction,
  client,
  indexId,
  accepted,
  testNow,
}: ProveAcceptedCorpusProjectionRevisionsOptions): Promise<
  Result<AcceptedCorpusProjectionAppendProof[], CorpusIndexError>
> => {
  const outcomes: AcceptedCorpusProjectionAppendProof[] = [];
  for (const batch of chunkItems(
    accepted,
    CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  )) {
    const census = await proveCorpusProjectionRevisionsPresent({
      client,
      indexId,
      expected: batch,
    });
    if (census.isErr()) {
      return Result.err(census.error);
    }
    const proven = await runInTransaction(
      async (tx) =>
        await proveAcceptedCorpusProjectionAppendsTx(tx, {
          indexId,
          census: census.value,
          timing: PROOF_CYCLE_TIMING,
          testNow,
        }),
    );
    outcomes.push(...proven);
  }
  return Result.ok(outcomes);
};

type CorpusProjectionProofCycleResult = {
  /** Committed revisions whose barrier had passed, read for this cycle. */
  claimed: number;
  applied: number;
  alreadyApplied: number;
  staleCleanupPending: number;
  unprovenCleanupPending: number;
  blocked: number;
  awaitingPublication: number;
  notAccepted: number;
};

const countCorpusProjectionProofOutcomes = (
  outcomes: readonly AcceptedCorpusProjectionAppendProof[],
): Omit<CorpusProjectionProofCycleResult, "claimed"> => {
  const counts = {
    applied: 0,
    alreadyApplied: 0,
    staleCleanupPending: 0,
    unprovenCleanupPending: 0,
    blocked: 0,
    awaitingPublication: 0,
    notAccepted: 0,
  };
  for (const outcome of outcomes) {
    switch (outcome.status) {
      case "applied":
        counts.applied += 1;
        break;
      case "already_applied":
        counts.alreadyApplied += 1;
        break;
      case "stale_cleanup_pending":
        counts.staleCleanupPending += 1;
        break;
      case "unproven_cleanup_pending":
        counts.unprovenCleanupPending += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "awaiting_publication":
        counts.awaitingPublication += 1;
        break;
      case "not_accepted":
        counts.notAccepted += 1;
        break;
      default:
        outcome satisfies never;
        return panic(`Unhandled proof outcome: ${String(outcome)}`);
    }
  }
  return counts;
};

type ExecuteCorpusProjectionProofCycleOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: Pick<CorpusIndexClient, "aggregate">;
  family: CorpusFamily;
  generation: string;
  indexId: string;
  /** Accepted revisions this cycle may prove. */
  limit: number;
  /** Deterministic database-test clock; production reads PostgreSQL. */
  testNow?: Date;
};

/**
 * Execute one bounded proof cycle over one index. It needs no lease: it reads
 * the accepted revisions whose publish barrier has passed, oldest first, and
 * proves them. The operator chooses the index, cadence and limit.
 */
export const executeCorpusProjectionProofCycle = async ({
  runInTransaction,
  client,
  family,
  generation,
  indexId,
  limit,
  testNow,
}: ExecuteCorpusProjectionProofCycleOptions): Promise<
  Result<CorpusProjectionProofCycleResult, CorpusIndexError>
> => {
  const accepted = await runInTransaction(
    async (tx) =>
      await readProvableCorpusProjectionAppendsTx(tx, {
        family,
        generation,
        indexId,
        limit,
        testNow,
      }),
  );
  const proven = await proveAcceptedCorpusProjectionRevisions({
    runInTransaction,
    client,
    indexId,
    accepted,
    testNow,
  });
  if (proven.isErr()) {
    return Result.err(proven.error);
  }
  return Result.ok({
    claimed: accepted.length,
    ...countCorpusProjectionProofOutcomes(proven.value),
  });
};
