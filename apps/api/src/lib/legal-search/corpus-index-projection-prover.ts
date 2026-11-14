import { panic } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type {
  CorpusIndexClient,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  proveCorpusProjectionRevisionsPresent,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import type { CorpusProjectionAppendWorkScope } from "@/api/lib/legal-search/corpus-index-projection-scope";
import {
  type AcceptedCorpusProjectionAppendProof,
  type CorpusProjectionProofTiming,
  proveAcceptedCorpusProjectionAppendsTx,
  readProvableCorpusProjectionAppendsTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;

/** Committed revisions one proof cycle censuses: one exact aggregate. */
export const CORPUS_PROJECTION_PROOF_CYCLE_MAX_REVISIONS =
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS;

const PROOF_CYCLE_TIMING = {
  type: "after_barrier",
} as const satisfies CorpusProjectionProofTiming;

type CorpusProjectionProofCounts = {
  /** Committed revisions whose barrier had passed, read for this cycle. */
  claimed: number;
  applied: number;
  /** Not exactly present at the proof deadline; queued for cleanup. */
  retired: number;
  /** Not exactly present yet; a later cycle censuses them again. */
  waiting: number;
  staleCleanupPending: number;
  blocked: number;
  /** Another prover or an erasure acted on them first. */
  superseded: number;
};

/**
 * `afterIndexId` is the cursor the next pass takes: the index this pass took,
 * or the one it was given when nothing was provable.
 */
export type CorpusProjectionProofCycleResult =
  | { status: "idle"; afterIndexId: string | null }
  | ({
      status: "proved";
      indexId: string;
      afterIndexId: string;
    } & CorpusProjectionProofCounts)
  | {
      status: "census_failed";
      indexId: string;
      afterIndexId: string;
      claimed: number;
      error: CorpusIndexError;
    };

const countProofOutcomes = (
  outcomes: readonly AcceptedCorpusProjectionAppendProof[],
): Omit<CorpusProjectionProofCounts, "claimed"> => {
  const counts = {
    applied: 0,
    retired: 0,
    waiting: 0,
    staleCleanupPending: 0,
    blocked: 0,
    superseded: 0,
  };
  for (const outcome of outcomes) {
    switch (outcome.status) {
      case "applied":
        counts.applied += 1;
        break;
      case "unproven_cleanup_pending":
        counts.retired += 1;
        break;
      case "awaiting_publication":
        counts.waiting += 1;
        break;
      case "stale_cleanup_pending":
        counts.staleCleanupPending += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "already_applied":
      case "not_accepted":
        counts.superseded += 1;
        break;
      default:
        outcome satisfies never;
        return panic(`Unhandled proof outcome: ${String(outcome)}`);
    }
  }
  return counts;
};

type ExecuteCorpusProjectionProofCycleOptions<Family extends CorpusFamily> = {
  runInTransaction: ProjectionTransactionRunner;
  client: Pick<CorpusIndexClient, "aggregate">;
  family: Family;
  generation: string;
  scope: CorpusProjectionAppendWorkScope<NoInfer<Family>>;
  /** The previous pass's `afterIndexId`, or null for the first index. */
  afterIndexId: string | null;
  /** Deterministic database-test clock; production reads PostgreSQL. */
  testNow?: Date | undefined;
};

/**
 * One bounded proof cycle. It holds no lease: it takes the next index in
 * scope after `afterIndexId` that holds committed revisions past their
 * barrier, at most one census of them, and settles them in one transaction. A
 * crash between the census and that transaction writes nothing, so a later
 * cycle censuses again. A failed census settles nothing either: the documents
 * may well be published, so the revisions wait for a census that answers. The
 * append cycle runs it before it reserves, so a revision recorded as accepted
 * converges without another caller.
 */
export const executeCorpusProjectionProofCycle = async <
  Family extends CorpusFamily,
>({
  runInTransaction,
  client,
  family,
  generation,
  scope,
  afterIndexId,
  testNow,
}: ExecuteCorpusProjectionProofCycleOptions<Family>): Promise<CorpusProjectionProofCycleResult> => {
  const provable = await runInTransaction(
    async (tx) =>
      await readProvableCorpusProjectionAppendsTx(tx, {
        family,
        generation,
        scope,
        afterIndexId,
        limit: CORPUS_PROJECTION_PROOF_CYCLE_MAX_REVISIONS,
        testNow,
      }),
  );
  if (provable === null) {
    return { status: "idle", afterIndexId };
  }
  const { indexId, revisions } = provable;
  const census = await proveCorpusProjectionRevisionsPresent({
    client,
    indexId,
    expected: revisions,
  });
  if (census.isErr()) {
    return {
      status: "census_failed",
      indexId,
      afterIndexId: indexId,
      claimed: revisions.length,
      error: census.error,
    };
  }
  const outcomes = await runInTransaction(
    async (tx) =>
      await proveAcceptedCorpusProjectionAppendsTx(tx, {
        indexId,
        census: census.value,
        timing: PROOF_CYCLE_TIMING,
        testNow,
      }),
  );
  return {
    status: "proved",
    indexId,
    afterIndexId: indexId,
    claimed: revisions.length,
    ...countProofOutcomes(outcomes),
  };
};
