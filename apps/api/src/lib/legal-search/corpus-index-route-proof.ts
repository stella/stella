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
 * already walked are suspect too. Age restarts it as well: a pass picked up
 * after it started longer ago than a proof may be old is started over
 * (`pass_too_old_to_prove`, logged as `corpus_index.route_proof_pass_restarted`),
 * since its end could only write an expired proof.
 *
 * Page size. A page names its revisions in one engine aggregation, bounded by
 * the aggregation timeout (`CORPUS_INDEX_AGGREGATION_TIMEOUT_MS`), not by the
 * delete batch. Production pages of 128 revisions took 0.9 to 2.7 s at the
 * median and up to 9.8 s at the worst on one route, so the size is the
 * caller's to adapt (`nextCorpusIndexRouteCensusPageSize`): it starts at the
 * measured 128, halves on a census that timed out or took over half the
 * timeout, and doubles, up to `CORPUS_INDEX_ROUTE_CENSUS_PAGE_MAX`, after a
 * run of full pages that each took under a quarter of it. A page's size is
 * not part of its pass: the cursor alone says where the pass resumes, so a
 * pass begun at one size continues at any other.
 *
 * Every page logs `corpus_index.route_proof_page` (pages, revisions, elapsed
 * on the database clock, estimated remaining, restarts since the last clean
 * pass, the census time), so production measures what a pass costs.
 */
import { panic, Result } from "better-result";

import type { Transaction } from "@/api/db/types";
import {
  CORPUS_INDEX_AGGREGATION_TIMEOUT_MS,
  type CorpusIndexClient,
  type CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  censusAppliedCorpusProjections,
  censusSettledCorpusProjections,
} from "@/api/lib/legal-search/corpus-index-projection-census";
import { repairAppliedCorpusProjectionDriftTx } from "@/api/lib/legal-search/corpus-index-projection-census-store";
import { reopenCorpusProjectionCleanupTx } from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import {
  CORPUS_PROJECTION_CENSUS_MAX_REVISIONS,
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import type { CorpusIndexRouteCensusExpectation } from "@/api/lib/legal-search/corpus-index-route-proof-contract";
import {
  type CorpusIndexRoute,
  type CorpusIndexRouteCensusPass,
  type CorpusIndexRouteCensusStep,
  type CorpusIndexRoutePassRestart,
  type CorpusIndexRouteRefusal,
  recordCorpusIndexRouteCensusPageTx,
  startCorpusIndexRouteCensusPageTx,
} from "@/api/lib/legal-search/corpus-index-route-proof-store";
import { logger } from "@/api/lib/observability/logger";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { brandValidatedCorpusIndexProjectionIntentId } from "@/api/lib/safe-id-boundaries";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;

/** The page size a route's first page uses: the size production measured. */
const CORPUS_INDEX_ROUTE_CENSUS_PAGE_INITIAL = 128;
/** The largest page: four measured pages in one aggregation. */
export const CORPUS_INDEX_ROUTE_CENSUS_PAGE_MAX = Math.min(
  512,
  CORPUS_PROJECTION_CENSUS_MAX_REVISIONS,
);
/** The smallest page the size halves to; below it a timeout is a failure. */
export const CORPUS_INDEX_ROUTE_CENSUS_PAGE_MIN = 32;
/** A census slower than this halves the page before it times out. */
const CENSUS_SLOW_MS = CORPUS_INDEX_AGGREGATION_TIMEOUT_MS / 2;
/** A full page faster than this counts toward doubling the page. */
const CENSUS_FAST_MS = CORPUS_INDEX_AGGREGATION_TIMEOUT_MS / 4;
/** Fast full pages in a row before the page doubles. */
const CENSUS_FAST_STREAK = 4;

/** A route's census page size, and the fast full pages since it last changed. */
export type CorpusIndexRouteCensusPageSize = { limit: number; fast: number };

export const initialCorpusIndexRouteCensusPageSize =
  (): CorpusIndexRouteCensusPageSize => ({
    limit: CORPUS_INDEX_ROUTE_CENSUS_PAGE_INITIAL,
    fast: 0,
  });

/**
 * What one page's census says of the size the next one may take:
 *
 * - `timed_out`: the engine gave up inside the aggregation timeout; halve;
 * - `read`: it answered in `censusMs` for `revisions` of `limit` asked;
 *   slower than half the timeout halves, a full page faster than a quarter
 *   of it counts toward doubling, anything else keeps the size.
 */
type CorpusIndexRouteCensusOutcome =
  { type: "timed_out" } | { type: "read"; censusMs: number; revisions: number };

export const nextCorpusIndexRouteCensusPageSize = (
  size: CorpusIndexRouteCensusPageSize,
  outcome: CorpusIndexRouteCensusOutcome,
): CorpusIndexRouteCensusPageSize => {
  const halved = {
    limit: Math.max(
      Math.floor(size.limit / 2),
      CORPUS_INDEX_ROUTE_CENSUS_PAGE_MIN,
    ),
    fast: 0,
  };
  if (outcome.type === "timed_out" || outcome.censusMs > CENSUS_SLOW_MS) {
    return halved;
  }
  if (outcome.revisions < size.limit || outcome.censusMs >= CENSUS_FAST_MS) {
    return { limit: size.limit, fast: 0 };
  }
  const fast = size.fast + 1;
  return fast < CENSUS_FAST_STREAK
    ? { limit: size.limit, fast }
    : {
        limit: Math.min(size.limit * 2, CORPUS_INDEX_ROUTE_CENSUS_PAGE_MAX),
        fast: 0,
      };
};

/**
 * Whether an engine read failed by running out of time: its own timeout, or
 * a wait in the search queue that its timeout ended. A smaller page asks the
 * engine for less, and waits behind less.
 */
export const isCorpusIndexReadTimeout = (error: CorpusIndexError): boolean => {
  if (error.reach === "budget_expired") {
    return true;
  }
  return (
    error.reach !== "caller_aborted" &&
    error.cause instanceof Error &&
    error.cause.name === "TimeoutError"
  );
};

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

/** What one page did, with how long its census read took. */
export type CorpusIndexRouteProofPage = {
  advance: CorpusIndexRouteProofAdvance;
  /** How long the page's census took; null when it read none. */
  censusMs: number | null;
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
  censusMs,
  walked,
}: {
  route: CorpusIndexRoute;
  pass: CorpusIndexRouteCensusPass;
  limit: number;
  pageMs: number;
  censusMs: number | null;
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
    ...(censusMs === null ? {} : { censusMs }),
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

/** One line per open pass started over instead of resumed, with why. */
const logPassRestart = ({
  route,
  pass,
  restarted: { reason, abandoned },
}: {
  route: CorpusIndexRoute;
  pass: CorpusIndexRouteCensusPass;
  restarted: CorpusIndexRoutePassRestart;
}): void => {
  logger.info("corpus_index.route_proof_pass_restarted", {
    family: route.family,
    generation: route.generation,
    index: route.indexId,
    reason,
    passNumber: pass.number,
    abandonedPassNumber: abandoned.number,
    abandonedPassRows: abandoned.inspected,
    abandonedPassAgeHours: Math.round(abandoned.elapsedMs / 360_000) / 10,
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
): Promise<{
  walked: Result<CensusPage, CorpusIndexError>;
  censusMs: number | null;
}> => {
  const done = (
    advance: CorpusIndexRouteProofAdvance,
    censusMs: number | null,
  ) => ({ walked: Result.ok({ type: "done", advance } as const), censusMs });
  const failed = (error: CorpusIndexError, censusMs: number | null) => ({
    walked: Result.err(error),
    censusMs,
  });
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
      return failed(counted.error, null);
    }
    if (counted.value.numHits !== 0) {
      return done(
        { type: "unknown_documents", documents: counted.value.numHits },
        null,
      );
    }
  }
  const censusStartedAt = performance.now();
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
  const censusMs =
    pass.through === null
      ? null
      : Math.round(performance.now() - censusStartedAt);
  if (page.isErr()) {
    return failed(page.error, censusMs);
  }
  const { driftRevisions, inspected, nextCursor } = page.value;
  if (driftRevisions.length > 0) {
    return {
      walked: Result.ok({
        type: "drift",
        expectation: pass.expectation,
        revisions: driftRevisions,
      }),
      censusMs,
    };
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
    return failed(endObserved.error, censusMs);
  }
  const endIncarnation =
    endObserved.value.type === "missing" ? null : endObserved.value.incarnation;
  if (endIncarnation === null) {
    return done({ type: "index_missing" }, censusMs);
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
    censusMs,
  );
};

const censusPage = async ({
  runInTransaction,
  client,
  route,
  limit,
}: Omit<AdvanceOptions, "admit" | "limit"> & { limit: number }): Promise<{
  walked: Result<CensusPage, CorpusIndexError>;
  censusMs: number | null;
}> => {
  const done = (advance: CorpusIndexRouteProofAdvance) => ({
    walked: Result.ok({ type: "done", advance } as const),
    censusMs: null,
  });
  const observed = await client.readIndexIncarnation(
    route.indexId,
    "unobserved",
  );
  if (observed.isErr()) {
    return { walked: Result.err(observed.error), censusMs: null };
  }
  const started = await runInTransaction(
    async (tx) =>
      await startCorpusIndexRouteCensusPageTx(tx, route, observed.value),
  );
  if (started.type !== "pass") {
    return done(started);
  }
  const { pass, restarted } = started;
  if (restarted !== null) {
    logPassRestart({ route, pass, restarted });
  }
  const pageStartedAt = performance.now();
  const { walked, censusMs } = await walkPage(
    { runInTransaction, client, route, limit },
    pass,
  );
  logCensusPage({
    route,
    pass,
    limit,
    pageMs: Math.round(performance.now() - pageStartedAt),
    censusMs,
    walked,
  });
  return { walked, censusMs };
};

/**
 * Walk one census page of the route's pass, `limit` revisions, and repair
 * what drift it found.
 */
export const advanceCorpusIndexRouteProof = async ({
  runInTransaction,
  client,
  admit,
  route,
  limit = CORPUS_INDEX_ROUTE_CENSUS_PAGE_INITIAL,
}: AdvanceOptions): Promise<
  Result<CorpusIndexRouteProofPage, CorpusIndexError>
> => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CORPUS_PROJECTION_CENSUS_MAX_REVISIONS
  ) {
    return panic(`Route census page size out of bounds: ${limit}`);
  }
  const page = await admit(
    { step: "census", revisions: limit },
    async () => await censusPage({ runInTransaction, client, route, limit }),
  );
  if (page.walked.isErr()) {
    return Result.err(page.walked.error);
  }
  const { censusMs } = page;
  if (page.walked.value.type === "done") {
    return Result.ok({ advance: page.walked.value.advance, censusMs });
  }
  const { expectation } = page.walked.value;
  // One repair batch per page: the repair revokes the proof and the pass
  // starts over, so drift past the batch is found again by the new pass.
  const revisions = page.walked.value.revisions.slice(
    0,
    CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  );
  const repaired = await admit(
    { step: "repair", revisions: revisions.length },
    async () =>
      await runInTransaction(
        async (tx) => await repairDriftTx(tx, route, expectation, revisions),
      ),
  );
  return Result.ok({
    advance: { type: "drift_repaired", expectation, repaired },
    censusMs,
  });
};
