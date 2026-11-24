/**
 * Advance one route's readiness proof by one census page.
 *
 * The runner calls this once per page, and every page goes through the
 * runner's load governor (`admit`), so a pass yields at each page boundary.
 * `admit` is required and has no default: the runner passes the governor it
 * shares with the projection's other background work, never a pass-through.
 * Each call reads which engine incarnation holds the route's index, reads the
 * route's pass, censuses one page of it against the engine outside any
 * transaction, and records the page. A pass walks the applied revisions the
 * index must hold, then the settled and withdrawn ones it must not; the end
 * of a clean pass, on the incarnation it started on, is the route's proof.
 * Drift found on a page is repaired here, by the repair that already owns
 * it, and that repair revokes the proof in its own transaction; the pass
 * then starts over.
 *
 * Writes never restart a pass: every move into applied, settled or withdrawn
 * carries its own exact engine observation (see the store), so a pass ends
 * under any inflow after one walk of the route. A repair does restart it: a
 * revision the engine lost or kept is evidence about the index, not about
 * one key (a lost split holds documents of every key range), so the keys
 * already walked are suspect too.
 *
 * What a pass costs on the largest route is not measured yet; every page logs
 * `corpus_index.route_proof_page` (pages, revisions, elapsed on the database
 * clock, estimated remaining, restarts since the last clean pass), so the
 * first production pass measures it.
 */
import { panic, Result } from "better-result";

import type { Transaction } from "@/api/db/types";
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
  type CorpusIndexRouteCensusPass,
  type CorpusIndexRouteCensusStep,
  type CorpusIndexRouteRefusal,
  recordCorpusIndexRouteCensusPageTx,
  startCorpusIndexRouteCensusPageTx,
} from "@/api/lib/legal-search/corpus-index-route-proof-store";
import { logger } from "@/api/lib/observability/logger";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { brandValidatedCorpusIndexProjectionIntentId } from "@/api/lib/safe-id-boundaries";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;

/** One unit of database and engine work the caller's load governor admits. */
export type CorpusIndexRouteProofWorkUnit = {
  /** `census`: one page read and recorded; `repair`: the drift it found. */
  step: "census" | "repair";
  /** Revisions the unit touches, the governor's weight. */
  revisions: number;
};

/**
 * The caller's admission: run `work` once the governor admits the unit, and
 * hold the admission until it settles. The proof never knows how the governor
 * decides; it only waits.
 */
export type CorpusIndexRouteProofAdmission = <Value>(
  unit: CorpusIndexRouteProofWorkUnit,
  work: () => Promise<Value>,
) => Promise<Value>;

export type CorpusIndexRouteProofAdvance =
  | (Exclude<CorpusIndexRouteCensusStep, { type: "refused" }> & {
      expectation: CorpusIndexRouteCensusExpectation;
      inspected: number;
    })
  | {
      /** The page found drift; the repair ran and revoked the route's proof. */
      type: "drift_repaired";
      expectation: CorpusIndexRouteCensusExpectation;
      repaired: number;
    }
  /** The route may not be walked now (`CorpusIndexRouteRefusal`). */
  | { type: "refused"; refusal: CorpusIndexRouteRefusal }
  /** The engine holds no index under the route's id; nothing is proven. */
  | { type: "index_missing" }
  /**
   * PostgreSQL records nothing applied on the route, yet the index holds
   * documents: ones PostgreSQL does not know, or ones still in flight. The
   * route stays unproven until the index matches.
   */
  | { type: "unknown_documents"; documents: number };

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

type CensusPage =
  | { type: "done"; advance: CorpusIndexRouteProofAdvance }
  | {
      type: "drift";
      expectation: CorpusIndexRouteCensusExpectation;
      revisions: string[];
    };

type AdvanceOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: Pick<
    CorpusIndexClient,
    "aggregate" | "readIndexIncarnation" | "search"
  >;
  admit: CorpusIndexRouteProofAdmission;
  route: CorpusIndexRoute;
  limit?: number;
};

/**
 * One progress line per census page, so a production pass measures what a
 * pass costs (pages, revisions, elapsed, estimated remaining, restarts)
 * instead of the plan assuming it. Elapsed is on the database clock the pass
 * started on; the estimate scales the last clean pass's count by this pass's
 * rate, and is left out until one pass has completed.
 */
const logCensusPage = ({
  route,
  pass,
  limit,
  pageMs,
  walked,
}: {
  route: CorpusIndexRoute;
  pass: CorpusIndexRouteCensusPass;
  limit: number;
  pageMs: number;
  walked: Result<CensusPage, CorpusIndexError>;
}): void => {
  const outcome = (() => {
    if (walked.isErr()) {
      return "engine_error";
    }
    return walked.value.type === "drift" ? "drift" : walked.value.advance.type;
  })();
  const pageRows =
    walked.isOk() &&
    walked.value.type === "done" &&
    "inspected" in walked.value.advance
      ? walked.value.advance.inspected
      : 0;
  const passRows = pass.inspected + pageRows;
  const elapsedSeconds = (pass.elapsedMs + pageMs) / 1000;
  const rowsPerSecond = elapsedSeconds > 0 ? passRows / elapsedSeconds : null;
  const estimatedRemainingSeconds =
    pass.lastProof === null || rowsPerSecond === null || rowsPerSecond === 0
      ? null
      : Math.round(
          Math.max(pass.lastProof.inspected - passRows, 0) / rowsPerSecond,
        );
  logger.info("corpus_index.route_proof_page", {
    family: route.family,
    generation: route.generation,
    index: route.indexId,
    passNumber: pass.number,
    phase: pass.expectation,
    outcome,
    pageLimit: limit,
    pageRows,
    pageMs,
    // Full pages' worth walked; a phase's last page may be short.
    passPages: Math.ceil(passRows / limit),
    passRows,
    passElapsedSeconds: Math.round(elapsedSeconds),
    // Unknown values are left out rather than logged as a placeholder.
    ...(rowsPerSecond === null
      ? {}
      : { rowsPerSecond: Math.round(rowsPerSecond * 10) / 10 }),
    ...(pass.lastProof === null
      ? {}
      : { lastProofRows: pass.lastProof.inspected }),
    ...(estimatedRemainingSeconds === null
      ? {}
      : { estimatedRemainingSeconds }),
    restartsSinceProof: pass.number - (pass.lastProof?.number ?? 0) - 1,
  });
};

const walkPage = async (
  {
    runInTransaction,
    client,
    route,
    limit,
  }: Omit<AdvanceOptions, "admit" | "limit"> & { limit: number },
  pass: CorpusIndexRouteCensusPass,
): Promise<Result<CensusPage, CorpusIndexError>> => {
  const done = (advance: CorpusIndexRouteProofAdvance) =>
    Result.ok({ type: "done", advance } as const);
  const incarnation =
    pass.incarnation ?? panic("A started route census pass has no incarnation");
  // A phase that began with nothing to walk still reads the engine: an empty
  // `present` phase proves the index holds no document at all, so a route
  // PostgreSQL records as empty is never proven without looking. An empty
  // `absent` phase has nothing that must be missing; the incarnation reads
  // around it are its look at the engine.
  if (pass.through === null && pass.expectation === "present") {
    const counted = await client.search({
      observer: "unobserved",
      indexId: route.indexId,
      query: "*",
      maxHits: 0,
    });
    if (counted.isErr()) {
      return Result.err(counted.error);
    }
    if (counted.value.numHits !== 0) {
      return done({
        type: "unknown_documents",
        documents: counted.value.numHits,
      });
    }
  }
  const page =
    pass.through === null
      ? Result.ok({
          driftRevisions: [],
          inspected: 0,
          nextCursor: null,
          complete: true,
        })
      : await CENSUS_PAGES[pass.expectation]({
          runInTransaction,
          client,
          family: route.family,
          generation: route.generation,
          indexId: route.indexId,
          after: pass.cursor,
          through: pass.through,
          limit,
        });
  if (page.isErr()) {
    return Result.err(page.error);
  }
  const { driftRevisions, inspected, nextCursor } = page.value;
  if (driftRevisions.length > 0) {
    return Result.ok({
      type: "drift",
      expectation: pass.expectation,
      revisions: driftRevisions,
    });
  }
  // A page ending on the phase's last key ends the phase without one more
  // empty page.
  const complete =
    page.value.complete || (nextCursor !== null && nextCursor === pass.through);
  // The pass's end reads the incarnation once more, after its last census
  // read: the same uid at the start and the end means one index throughout.
  const ending = complete && pass.expectation === "absent";
  const endObserved = ending
    ? await client.readIndexIncarnation(route.indexId, "unobserved")
    : Result.ok({ type: "present", incarnation } as const);
  if (endObserved.isErr()) {
    return Result.err(endObserved.error);
  }
  const endIncarnation =
    endObserved.value.type === "missing" ? null : endObserved.value.incarnation;
  if (endIncarnation === null) {
    return done({ type: "index_missing" });
  }
  const step = await runInTransaction(
    async (tx) =>
      await recordCorpusIndexRouteCensusPageTx(tx, {
        route,
        pass,
        incarnation: endIncarnation,
        inspected,
        nextCursor,
        complete,
      }),
  );
  return done(
    step.type === "refused"
      ? step
      : { ...step, expectation: pass.expectation, inspected },
  );
};

const censusPage = async ({
  runInTransaction,
  client,
  route,
  limit,
}: Omit<AdvanceOptions, "admit" | "limit"> & { limit: number }): Promise<
  Result<CensusPage, CorpusIndexError>
> => {
  const done = (advance: CorpusIndexRouteProofAdvance) =>
    Result.ok({ type: "done", advance } as const);
  const observed = await client.readIndexIncarnation(
    route.indexId,
    "unobserved",
  );
  if (observed.isErr()) {
    return Result.err(observed.error);
  }
  const started = await runInTransaction(
    async (tx) =>
      await startCorpusIndexRouteCensusPageTx(tx, route, observed.value),
  );
  if (started.type !== "pass") {
    return done(started);
  }
  const { pass } = started;
  const pageStartedAt = performance.now();
  const walked = await walkPage(
    { runInTransaction, client, route, limit },
    pass,
  );
  logCensusPage({
    route,
    pass,
    limit,
    pageMs: Math.round(performance.now() - pageStartedAt),
    walked,
  });
  return walked;
};

export const advanceCorpusIndexRouteProof = async ({
  runInTransaction,
  client,
  admit,
  route,
  limit = CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
}: AdvanceOptions): Promise<
  Result<CorpusIndexRouteProofAdvance, CorpusIndexError>
> => {
  const page = await admit(
    { step: "census", revisions: limit },
    async () => await censusPage({ runInTransaction, client, route, limit }),
  );
  if (page.isErr()) {
    return Result.err(page.error);
  }
  if (page.value.type === "done") {
    return Result.ok(page.value.advance);
  }
  const { expectation, revisions } = page.value;
  const repaired = await admit(
    { step: "repair", revisions: revisions.length },
    async () =>
      await runInTransaction(
        async (tx) => await repairDriftTx(tx, route, expectation, revisions),
      ),
  );
  return Result.ok({ type: "drift_repaired", expectation, repaired });
};
