import { panic } from "better-result";

import { compareCodeUnit } from "@stll/collation";
import { mapWithConcurrency } from "@stll/concurrency";

import type { Transaction } from "@/api/db/root";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { censusCorpusProjectionRevisions } from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  CORPUS_PROJECTION_GENERATION_SCOPE,
  type CorpusProjectionScopedWorkOptions,
} from "@/api/lib/legal-search/corpus-index-projection-scope";
import {
  abandonUnpublishedCorpusProjectionAppendTx,
  type AbandonUnpublishedCorpusProjectionAppendResult,
  type AcceptedCorpusProjectionAppend,
  confirmCorpusProjectionAppendTx,
  type ConfirmCorpusProjectionAppendResult,
  CORPUS_PROJECTION_APPEND_RETRY_BASE_MS,
  type CorpusProjectionUnpublishedReason,
  readAcceptedCorpusProjectionAppendsTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";

const CONFIRMATION_CENSUS_UNAVAILABLE_SINK = failureSink({
  event: "corpus_projection.confirmation_census_unavailable",
  expected: [],
});

type ConfirmCorpusProjectionAppendsOptions<Family extends CorpusFamily> =
  CorpusProjectionScopedWorkOptions<Family> & {
    runInTransaction: IngestionTransactionRunner<Transaction>;
    client: Pick<CorpusIndexClient, "aggregate">;
    generation: string;
    /** Accepted revisions inspected per pass, oldest acceptance first. */
    limit: number;
  };

export type CorpusProjectionConfirmationResult = {
  status: "idle" | "completed" | "engine_unavailable";
  cycleRetryDelayMs: number | null;
  inspected: number;
  applied: number;
  /** Not searchable in full yet, inside their confirmation window. */
  awaitingPublication: number;
  /** Given up through exact cleanup: overdue or overcounted. */
  unpublishedCleanupPending: number;
  staleCleanupPending: number;
  blocked: number;
  /** Resolved by another worker between this pass's read and its write. */
  superseded: number;
};

type ConfirmationTransition =
  | {
      kind: "confirm";
      append: AcceptedCorpusProjectionAppend;
      observed: number;
    }
  | {
      kind: "abandon";
      append: AcceptedCorpusProjectionAppend;
      observed: number;
      reason: CorpusProjectionUnpublishedReason;
    };

type ConfirmationVerdict = ConfirmationTransition | { kind: "await" };

const verdictFor = (
  append: AcceptedCorpusProjectionAppend,
  observed: number,
): ConfirmationVerdict => {
  if (observed === append.expectedDocumentCount) {
    return { kind: "confirm", append, observed };
  }
  if (observed > append.expectedDocumentCount) {
    return { kind: "abandon", append, observed, reason: "overcounted" };
  }
  switch (append.publication) {
    case "overdue":
      return { kind: "abandon", append, observed, reason: "overdue" };
    case "awaited":
      return { kind: "await" };
    default:
      append.publication satisfies never;
      return panic(`Unhandled publication: ${String(append.publication)}`);
  }
};

const groupByIndex = (
  appends: readonly AcceptedCorpusProjectionAppend[],
): [string, AcceptedCorpusProjectionAppend[]][] =>
  [...Map.groupBy(appends, ({ indexId }) => indexId)].toSorted(
    ([left], [right]) => compareCodeUnit(left, right),
  );

type TransitionOutcome =
  | {
      kind: "confirm";
      transition: Extract<ConfirmationTransition, { kind: "confirm" }>;
      outcome: ConfirmCorpusProjectionAppendResult;
    }
  | {
      kind: "abandon";
      transition: Extract<ConfirmationTransition, { kind: "abandon" }>;
      outcome: AbandonUnpublishedCorpusProjectionAppendResult;
    };

const applyTransitionTx = async (
  tx: Transaction,
  transition: ConfirmationTransition,
): Promise<TransitionOutcome> => {
  switch (transition.kind) {
    case "confirm":
      return {
        kind: "confirm",
        transition,
        outcome: await confirmCorpusProjectionAppendTx(tx, {
          intentId: transition.append.intentId,
          observedDocumentCount: transition.observed,
        }),
      };
    case "abandon":
      return {
        kind: "abandon",
        transition,
        outcome: await abandonUnpublishedCorpusProjectionAppendTx(tx, {
          intentId: transition.append.intentId,
          reason: transition.reason,
        }),
      };
    default:
      transition satisfies never;
      return panic(`Unhandled confirmation: ${String(transition)}`);
  }
};

const recordOutcome = (
  result: CorpusProjectionConfirmationResult,
  { kind, transition, outcome }: TransitionOutcome,
): void => {
  if (kind === "confirm") {
    switch (outcome.status) {
      case "applied":
        result.applied += 1;
        return;
      case "stale_cleanup_pending":
        result.staleCleanupPending += 1;
        return;
      case "not_confirmed":
      case "not_accepted":
        result.superseded += 1;
        return;
      default:
        outcome satisfies never;
        panic(`Unhandled confirmation outcome: ${String(outcome)}`);
    }
  }
  switch (outcome.status) {
    case "cleanup_pending":
      result.unpublishedCleanupPending += 1;
      break;
    case "blocked":
      result.unpublishedCleanupPending += 1;
      result.blocked += 1;
      logger.warn("corpus_projection.append_blocked", {
        entity: outcome.entityId,
        kind: outcome.kind,
        attempts: outcome.attempts,
      });
      break;
    case "not_due":
    case "not_accepted":
      result.superseded += 1;
      return;
    default:
      outcome satisfies never;
      panic(`Unhandled unpublished append outcome: ${String(outcome)}`);
  }
  logger.warn("corpus_projection.append_unpublished", {
    indexId: transition.append.indexId,
    revision: transition.append.intentId,
    reason: transition.reason,
    expectedDocuments: transition.append.expectedDocumentCount,
    observedDocuments: transition.observed,
  });
};

/**
 * Promote accepted appends that an exact revision census finds searchable,
 * and give up the ones still missing when their confirmation window closes.
 *
 * Holds no append lease and no transaction across the census, so it can run
 * on its own cadence beside append cycles and repeat freely: every transition
 * re-locks its row and accepts only `append_committed`. A census failure is an
 * engine outage: nothing is abandoned on it, because absence was never
 * observed, and the caller backs off by `cycleRetryDelayMs`.
 */
export const confirmCorpusProjectionAppends = async <
  Family extends CorpusFamily,
>({
  runInTransaction,
  client,
  family,
  generation,
  scope = CORPUS_PROJECTION_GENERATION_SCOPE,
  limit,
}: ConfirmCorpusProjectionAppendsOptions<Family>): Promise<CorpusProjectionConfirmationResult> => {
  const accepted = await runInTransaction(
    async (tx) =>
      await readAcceptedCorpusProjectionAppendsTx(tx, {
        family,
        generation,
        scope,
        limit,
      }),
  );
  const result: CorpusProjectionConfirmationResult = {
    status: accepted.length === 0 ? "idle" : "completed",
    cycleRetryDelayMs: null,
    inspected: accepted.length,
    applied: 0,
    awaitingPublication: 0,
    unpublishedCleanupPending: 0,
    staleCleanupPending: 0,
    blocked: 0,
    superseded: 0,
  };
  const verdicts: ConfirmationVerdict[] = [];
  for (const [indexId, appends] of groupByIndex(accepted)) {
    // One census per physical index; the read limit keeps each within the
    // census bound, and a failure stops the pass before any later index.
    const census = await censusCorpusProjectionRevisions({
      client,
      indexId,
      revisions: appends.map(({ intentId }) => intentId),
    });
    if (census.isErr()) {
      observeFailure(census.error, {
        sink: CONFIRMATION_CENSUS_UNAVAILABLE_SINK,
        ctx: { feature: "corpus_projection.confirmation", source: indexId },
      });
      result.status = "engine_unavailable";
      result.cycleRetryDelayMs = CORPUS_PROJECTION_APPEND_RETRY_BASE_MS;
      break;
    }
    // The census answers for every requested revision: present with its
    // count, or missing.
    const observed = new Map<string, number>(
      census.value.missing.map((revision) => [revision, 0]),
    );
    for (const { revision, documentCount } of census.value.present) {
      observed.set(revision, documentCount);
    }
    for (const append of appends) {
      verdicts.push(
        verdictFor(
          append,
          observed.get(append.intentId) ??
            panic(`Census omitted revision ${append.intentId}`),
        ),
      );
    }
  }
  const transitions = verdicts.flatMap((verdict) =>
    verdict.kind === "await" ? [] : [verdict],
  );
  result.awaitingPublication = verdicts.length - transitions.length;
  if (transitions.length === 0) {
    return result;
  }
  const outcomes = await runInTransaction(
    async (tx) =>
      await mapWithConcurrency({
        items: transitions,
        // One transaction, one connection: transitions run in order.
        limit: 1,
        operation: async (transition) =>
          await applyTransitionTx(tx, transition),
      }),
  );
  for (const outcome of outcomes) {
    recordOutcome(result, outcome);
  }
  return result;
};
