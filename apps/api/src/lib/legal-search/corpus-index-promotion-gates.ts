/**
 * The proofs a corpus target must pass before readers are pointed at it.
 *
 * A generation promotion (`scripts/corpus-generation.ts serve`) and the gated
 * flip of one jurisdiction to a partial generation
 * (`case-law-serving-flip.ts`) are the same decision about different scopes,
 * so they share one set of gates rather than two that drift:
 *
 * - the target's projection has converged: nothing pending, blocked,
 *   outstanding or unpublished;
 * - every index the target must answer from exists on the search endpoint and
 *   holds documents;
 * - a full engine census finds no drift: every applied revision present with
 *   its expected document count, every settled one absent.
 *
 * The caller proves them at one projection revision and re-checks that
 * revision under the promotion fence in the transaction that flips.
 */
import { panic, Result, TaggedError } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  censusAppliedCorpusProjections,
  censusSettledCorpusProjections,
} from "@/api/lib/legal-search/corpus-index-projection-census";
import type { CorpusIndexProjectionConvergenceStatus } from "@/api/lib/legal-search/corpus-index-projection-convergence";
import { CORPUS_PROJECTION_DELETE_MAX_REVISIONS } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { corpusIndexReadContract } from "@/api/lib/legal-search/corpus-index-read-contract";

class CorpusGenerationIndexMissingError extends TaggedError(
  "CorpusGenerationIndexMissingError",
)<{ message: string; indexId: string }> {}

class CorpusGenerationIndexEmptyError extends TaggedError(
  "CorpusGenerationIndexEmptyError",
)<{ message: string; indexId: string }> {}

class CorpusGenerationIndexUnreadableError extends TaggedError(
  "CorpusGenerationIndexUnreadableError",
)<{ message: string; indexId: string; cause: unknown }> {}

export class CorpusGenerationNotConvergedError extends TaggedError(
  "CorpusGenerationNotConvergedError",
)<{
  message: string;
  convergence: CorpusIndexProjectionConvergenceStatus;
}> {}

type CensusExpectation = "present" | "absent";

export class CorpusGenerationCensusDriftError extends TaggedError(
  "CorpusGenerationCensusDriftError",
)<{
  message: string;
  indexId: string;
  expected: CensusExpectation;
  driftRevisions: string[];
}> {}

export class CorpusGenerationCensusUnreadableError extends TaggedError(
  "CorpusGenerationCensusUnreadableError",
)<{ message: string; indexId: string; cause: unknown }> {}

export class CorpusGenerationProjectionMovedError extends TaggedError(
  "CorpusGenerationProjectionMovedError",
)<{ message: string; provenRevision: number; currentRevision: number }> {}

export type CorpusIndexReader = Pick<CorpusIndexClient, "search" | "aggregate">;

/** The target a proof is about: a generation, whole or partial. */
export type CorpusPromotionTarget = {
  family: CorpusFamily;
  generation: string;
};

/** Why a projection convergence state holds back the flip; null proceeds. */
const CONVERGENCE_REFUSAL_REASONS = {
  empty: "has no projected entities, so it would serve nothing",
  known_blocked: "has blocked projection work that must be cleared first",
  pending: "has projection work pending",
  intent_outstanding: "has append or cleanup revisions outstanding",
  publish_pending:
    "has applied revisions the engine has not certainly published yet",
  ready_for_census: null,
} as const satisfies Record<
  CorpusIndexProjectionConvergenceStatus,
  string | null
>;

export const requireConverged = (
  target: CorpusPromotionTarget,
  convergence: CorpusIndexProjectionConvergenceStatus,
): Result<void, CorpusGenerationNotConvergedError> => {
  const reason = CONVERGENCE_REFUSAL_REASONS[convergence];
  return reason === null
    ? Result.ok()
    : Result.err(
        new CorpusGenerationNotConvergedError({
          message: `${target.family}/${target.generation} ${reason} (projection ${convergence})`,
          convergence,
        }),
      );
};

type IndexEvidence = { indexId: string; documents: number };

export type IndexRefusal =
  | CorpusGenerationIndexMissingError
  | CorpusGenerationIndexEmptyError
  | CorpusGenerationIndexUnreadableError;

/** The status the engine answers a search of an index that does not exist with. */
const HTTP_NOT_FOUND = 404;

/**
 * Count each required index's documents (opening passages, one per
 * document) on the search endpoint. Sequential: a handful of count-only
 * requests, and the first refusal is the one an operator acts on.
 */
export const checkIndexesHoldDocuments = async (
  target: CorpusPromotionTarget,
  indexIds: readonly string[],
  client: CorpusIndexReader,
): Promise<Result<IndexEvidence[], IndexRefusal>> => {
  const { openingPassageQuery } = corpusIndexReadContract(
    target.family,
    target.generation,
  );
  const evidence: IndexEvidence[] = [];
  for (const indexId of indexIds) {
    // Sequential, so the first refusal is the one an operator acts on.
    const counted = await client.search({
      observer: "unobserved",
      indexId,
      query: openingPassageQuery,
      maxHits: 0,
    });
    if (counted.isErr()) {
      return Result.err(
        counted.error.status === HTTP_NOT_FOUND
          ? new CorpusGenerationIndexMissingError({
              message: `Index ${indexId} does not exist on the search endpoint`,
              indexId,
            })
          : new CorpusGenerationIndexUnreadableError({
              message: `Index ${indexId} could not be counted: ${counted.error.message}`,
              indexId,
              cause: counted.error,
            }),
      );
    }
    if (counted.value.numHits === 0) {
      return Result.err(
        new CorpusGenerationIndexEmptyError({
          message: `Index ${indexId} holds no documents on the search endpoint`,
          indexId,
        }),
      );
    }
    evidence.push({ indexId, documents: counted.value.numHits });
  }
  return Result.ok(evidence);
};

/** The passes a full census runs over every index, applied revisions first. */
const CENSUS_PASSES = [
  { kind: "applied", pass: censusAppliedCorpusProjections },
  { kind: "settled", pass: censusSettledCorpusProjections },
] as const;

type CensusPass = (typeof CENSUS_PASSES)[number]["pass"];

// Annotated at the loop: `after` feeds the next call and is reassigned from
// the page, so inference alone would be circular.
type CensusPassPage = Awaited<ReturnType<CensusPass>>;

type CensusPassOptions = {
  pass: CensusPass;
  runInTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  client: CorpusIndexReader;
  target: CorpusPromotionTarget;
  indexId: string;
};

export type CensusRefusal =
  CorpusGenerationCensusDriftError | CorpusGenerationCensusUnreadableError;

/** Page one census pass over one index to its end; resolves with the revisions inspected. */
const runCensusPass = async ({
  pass,
  runInTransaction,
  client,
  target,
  indexId,
}: CensusPassOptions): Promise<Result<number, CensusRefusal>> => {
  let after: string | null = null;
  let inspected = 0;
  for (;;) {
    // db-await-in-loop: a keyset walk; each page's cursor comes from the one before it
    const page: CensusPassPage = await pass({
      runInTransaction,
      client,
      family: target.family,
      generation: target.generation,
      indexId,
      after,
      limit: CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
    });
    if (page.isErr()) {
      return Result.err(
        new CorpusGenerationCensusUnreadableError({
          message: `The census of ${indexId} could not be read: ${page.error.message}`,
          indexId,
          cause: page.error,
        }),
      );
    }
    const { expected, driftRevisions, complete } = page.value;
    if (driftRevisions.length > 0) {
      return Result.err(
        new CorpusGenerationCensusDriftError({
          message: `The census of ${indexId} found ${String(driftRevisions.length)} revisions not ${expected} in the engine as recorded; let the projection repair them first`,
          indexId,
          expected,
          driftRevisions,
        }),
      );
    }
    inspected += page.value.inspected;
    if (complete || page.value.nextCursor === null) {
      return Result.ok(inspected);
    }
    after = page.value.nextCursor;
  }
};

export type CensusEvidence = {
  indexIds: string[];
  applied: number;
  settled: number;
};

/**
 * The full zero-drift census over these indexes: every applied revision
 * present in the engine with its expected document count, every settled one
 * absent. Read-only and outside any write transaction: it proves the
 * snapshot's revision, which the flip re-checks under the promotion fence.
 */
export const censusIndexes = async ({
  runInTransaction,
  client,
  target,
  indexIds,
}: {
  runInTransaction: CensusPassOptions["runInTransaction"];
  client: CorpusIndexReader;
  target: CorpusPromotionTarget;
  indexIds: string[];
}): Promise<Result<CensusEvidence, CensusRefusal>> => {
  const evidence: CensusEvidence = { indexIds, applied: 0, settled: 0 };
  const passes = indexIds.flatMap((indexId) =>
    CENSUS_PASSES.map(({ kind, pass }) => ({ indexId, kind, pass })),
  );
  for (const { indexId, kind, pass } of passes) {
    // db-await-in-loop: sequential, so the first drifted index is the one an operator acts on
    const inspected = await runCensusPass({
      pass,
      runInTransaction,
      client,
      target,
      indexId,
    });
    if (inspected.isErr()) {
      return Result.err(inspected.error);
    }
    switch (kind) {
      case "applied":
        evidence.applied += inspected.value;
        break;
      case "settled":
        evidence.settled += inspected.value;
        break;
      default:
        kind satisfies never;
        return panic(`Unhandled census pass: ${String(kind)}`);
    }
  }
  return Result.ok(evidence);
};
