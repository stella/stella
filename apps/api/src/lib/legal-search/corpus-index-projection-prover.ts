import { panic } from "better-result";

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
import type { CorpusProjectionAppendWorkScope } from "@/api/lib/legal-search/corpus-index-projection-scope";
import {
  type AcceptedCorpusProjectionAppendProof,
  proveAcceptedCorpusProjectionAppendsTx,
  readCommittedCorpusProjectionRevisionsTx,
  readProvableCorpusProjectionAppendsTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;

/** Committed revisions one proof cycle censuses: one exact aggregate. */
export const CORPUS_PROJECTION_PROOF_CYCLE_MAX_REVISIONS =
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS;

type CorpusProjectionProofCounts = {
  /** Committed revisions whose barrier had passed, read for this cycle. */
  claimed: number;
  applied: number;
  /** Not exactly present at the proof deadline; queued for cleanup. */
  retired: number;
  /** Offline, and empty once its indexer had ended; no cleanup owed. */
  withdrawn: number;
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
    withdrawn: 0,
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
      case "withdrawn":
        counts.withdrawn += 1;
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
 * converges without another caller. The read dates the census by the database
 * clock, so an offline revision's count counts as final only when its indexer
 * had certainly ended before the census looked.
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
  const { indexId, revisions, censusStart } = provable;
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
        timing: { type: "after_barrier", censusStart },
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

type ProjectionRevision = SafeId<"corpusIndexProjectionIntent">;

/**
 * Where each named revision stands after one proof of them. `outcomes` are
 * the proof's decisions over the revisions that were past their barrier; a
 * census that failed decided nothing, so they wait like `unpublished` ones.
 */
export type CorpusProjectionRevisionProofResult = {
  outcomes: AcceptedCorpusProjectionAppendProof[];
  /** Committed, with a barrier still ahead: not censused. */
  unpublished: ProjectionRevision[];
  /** Committed and past their barrier, but the census did not answer. */
  censusFailed: ProjectionRevision[];
  censusError: CorpusIndexError | null;
  /** No longer committed: decided, erased or recovered by another actor. */
  settled: ProjectionRevision[];
};

type ProveCorpusProjectionRevisionsOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: Pick<CorpusIndexClient, "aggregate">;
  family: CorpusFamily;
  generation: string;
  indexId: string;
  /** At most one census of revisions, all of `indexId`. */
  revisions: readonly ProjectionRevision[];
  /** Of `revisions`, those whose failure is never charged to the entity. */
  uncharged?: ReadonlySet<ProjectionRevision> | undefined;
  /** Deterministic database-test clock; production reads PostgreSQL. */
  testNow?: Date | undefined;
};

/**
 * One proof of the revisions a caller names: the same census and the same
 * settling transaction as the proof cycle, over a set the caller chose
 * instead of the index's oldest barriers. The read dates the census by the
 * database clock, so an offline revision's inexact count is final only when
 * its indexer had certainly ended before the census looked.
 */
export const proveCorpusProjectionRevisions = async ({
  runInTransaction,
  client,
  family,
  generation,
  indexId,
  revisions,
  uncharged,
  testNow,
}: ProveCorpusProjectionRevisionsOptions): Promise<CorpusProjectionRevisionProofResult> => {
  const committed = await runInTransaction(
    async (tx) =>
      await readCommittedCorpusProjectionRevisionsTx(tx, {
        family,
        generation,
        indexId,
        revisions,
        testNow,
      }),
  );
  const result: CorpusProjectionRevisionProofResult = {
    outcomes: [],
    unpublished: committed.unpublished,
    censusFailed: [],
    censusError: null,
    settled: committed.settled,
  };
  if (committed.provable.length === 0) {
    return result;
  }
  const census = await proveCorpusProjectionRevisionsPresent({
    client,
    indexId,
    expected: committed.provable,
  });
  if (census.isErr()) {
    return {
      ...result,
      censusFailed: committed.provable.map(({ revision }) => revision),
      censusError: census.error,
    };
  }
  const outcomes = await runInTransaction(
    async (tx) =>
      await proveAcceptedCorpusProjectionAppendsTx(tx, {
        indexId,
        census: census.value,
        timing: { type: "after_barrier", censusStart: committed.censusStart },
        uncharged,
        testNow,
      }),
  );
  return { ...result, outcomes };
};
