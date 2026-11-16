/**
 * Advance one route's readiness proof by one census page.
 *
 * The runner calls this on a cadence it governs; each call reads the route's
 * pass, censuses one page of it against the engine outside any transaction,
 * and records the page. A pass walks the applied revisions the index must
 * hold, then the settled and withdrawn ones it must not, and the end of a
 * clean pass is the route's proof. Drift found on a page is repaired here, by
 * the repair that already owns it, and that repair revokes the proof in its
 * own transaction; the pass then starts over.
 *
 * Writes never restart a pass. A revision applied after the pass passed its
 * page was proven present by its own apply (the presence proof every apply
 * runs on), and one settled or withdrawn after that was proven gone when it
 * got that status; a later loss is the next pass's to find. So a pass ends
 * under any inflow, after one walk of the route.
 */
import { panic, Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import type {
  CorpusIndexClient,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  censusAppliedCorpusProjections,
  censusSettledCorpusProjections,
} from "@/api/lib/legal-search/corpus-index-projection-census";
import { repairAppliedCorpusProjectionDriftTx } from "@/api/lib/legal-search/corpus-index-projection-census-store";
import { reopenCorpusProjectionCleanupTx } from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { CORPUS_PROJECTION_DELETE_MAX_REVISIONS } from "@/api/lib/legal-search/corpus-index-projection-engine";
import type { CorpusIndexRouteCensusExpectation } from "@/api/lib/legal-search/corpus-index-route-proof-contract";
import {
  type CorpusIndexRoute,
  type CorpusIndexRouteCensusStep,
  ensureCorpusIndexRouteCensusPassTx,
  recordCorpusIndexRouteCensusPageTx,
} from "@/api/lib/legal-search/corpus-index-route-proof-store";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { brandValidatedCorpusIndexProjectionIntentId } from "@/api/lib/safe-id-boundaries";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;

export type CorpusIndexRouteProofAdvance =
  | (CorpusIndexRouteCensusStep & {
      expectation: CorpusIndexRouteCensusExpectation;
      inspected: number;
    })
  | {
      /** The page found drift; the repair ran and revoked the route's proof. */
      type: "drift_repaired";
      expectation: CorpusIndexRouteCensusExpectation;
      repaired: number;
    };

const CENSUS_PAGES = {
  present: censusAppliedCorpusProjections,
  absent: censusSettledCorpusProjections,
} as const satisfies Record<
  CorpusIndexRouteCensusExpectation,
  typeof censusAppliedCorpusProjections
>;

const projectionRevisions = (revisions: readonly string[]) =>
  revisions.map(
    (revision) =>
      brandValidatedCorpusIndexProjectionIntentId(revision) ??
      panic(`Census drift names a malformed revision: ${revision}`),
  );

/** Repair a page's drift by the repair that owns its kind. */
const repairDriftTx = async (
  tx: Transaction,
  route: CorpusIndexRoute,
  expectation: CorpusIndexRouteCensusExpectation,
  revisions: readonly string[],
): Promise<number> => {
  switch (expectation) {
    case "present":
      return await repairAppliedCorpusProjectionDriftTx(tx, {
        family: route.family,
        generation: route.generation,
        indexId: route.indexId,
        revisions: projectionRevisions(revisions),
      });
    case "absent":
      return await reopenCorpusProjectionCleanupTx(tx, {
        intentIds: projectionRevisions(revisions),
        indexId: route.indexId,
        errorMessage: "census observed a deleted revision in the engine",
      });
    default:
      expectation satisfies never;
      return panic(
        `Unhandled route census expectation: ${String(expectation)}`,
      );
  }
};

export const advanceCorpusIndexRouteProof = async ({
  runInTransaction,
  client,
  route,
  limit = CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
}: {
  runInTransaction: ProjectionTransactionRunner;
  client: Pick<CorpusIndexClient, "aggregate">;
  route: CorpusIndexRoute;
  limit?: number;
}): Promise<Result<CorpusIndexRouteProofAdvance, CorpusIndexError>> => {
  const pass = await runInTransaction(
    async (tx) => await ensureCorpusIndexRouteCensusPassTx(tx, route),
  );
  // The engine is read outside every transaction.
  const page = await CENSUS_PAGES[pass.expectation]({
    runInTransaction,
    client,
    family: route.family,
    generation: route.generation,
    indexId: route.indexId,
    after: pass.cursor,
    limit,
  });
  if (page.isErr()) {
    return Result.err(page.error);
  }
  const { driftRevisions, inspected, nextCursor, complete } = page.value;
  if (driftRevisions.length > 0) {
    const repaired = await runInTransaction(
      async (tx) =>
        await repairDriftTx(tx, route, pass.expectation, driftRevisions),
    );
    return Result.ok({
      type: "drift_repaired",
      expectation: pass.expectation,
      repaired,
    });
  }
  const step = await runInTransaction(
    async (tx) =>
      await recordCorpusIndexRouteCensusPageTx(tx, {
        route,
        pass,
        inspected,
        nextCursor,
        complete,
      }),
  );
  return Result.ok({ ...step, expectation: pass.expectation, inspected });
};
