/**
 * Keeps the route proofs of a generation flip current: walks every route of
 * the generations a flip or a flip back would read, one census page at a
 * time (`advanceCorpusIndexRouteProof`), for as long as the run's budget
 * lasts.
 *
 * Which generations. The one the operator names, the family's serving
 * generation, and the one the family's latest flip demoted while it is still
 * building (the keep window): the flip reads the candidate's proofs, a flip
 * back reads the demoted one's, and both read the serving one's role from the
 * registry. Before a flip that is the candidate and the serving generation;
 * after it, the same two, roles swapped, so one run spans the flip.
 *
 * A pass is never idled. A proof starts the route's next pass at the instant
 * it is recorded (the store), and a proof's age counts from its pass's start,
 * so a route the runner stopped walking would prove, later, only what its
 * stale pass began on. The runner therefore keeps walking every route until
 * its budget ends, and a crash or a stop resumes from the cursor the store
 * holds.
 *
 * Never inside a flip. Every transaction of the runner joins the shared side
 * of the projection mutation fence first, with a short lock timeout; the
 * flip holds its exclusive side for its whole decision, so no page is read or
 * recorded while a flip decides, whoever runs it. A page refused that way
 * records nothing; the runner waits and tries again, and stops as
 * `lock_unavailable` once locks have stayed refused past its patience. The fence
 * comes before any other lock a runner transaction takes (the drift repairs
 * take it first too), so a runner transaction never waits on a lock the flip
 * holds while holding one the flip wants.
 *
 * Paced by the caller's governor (`admit`), one unit per page and per repair,
 * and by a bounded number of routes walked at once. Engine failures and
 * transient database failures back off per route; a route the manifest no
 * longer lets anyone walk, or whose index is missing or holds documents
 * PostgreSQL does not know, is set aside and named in the report.
 */
import { panic, Result } from "better-result";
import { desc, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerationFlips,
  corpusIndexGenerations,
} from "@/api/db/schema";
import { setSharedLockTimeout } from "@/api/db/shared-pool-timeouts";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  CORPUS_INDEX_ACTIVE_GENERATION_STATUSES,
  type CorpusFamily,
} from "@/api/lib/legal-search/corpus-generation-contract";
import type {
  CorpusIndexClient,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import { lockCorpusIndexProjectionWriterTx } from "@/api/lib/legal-search/corpus-index-projection-revision";
import {
  advanceCorpusIndexRouteProof,
  type CorpusIndexRouteProofAdmission,
  type CorpusIndexRouteProofAdvance,
} from "@/api/lib/legal-search/corpus-index-route-proof";
import {
  type CorpusIndexGenerationRouteProofs,
  type CorpusIndexRoute,
  readCorpusIndexRouteProofsTx,
} from "@/api/lib/legal-search/corpus-index-route-proof-store";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";

type Runner = IngestionTransactionRunner<Transaction>;

type ProofClient = Pick<
  CorpusIndexClient,
  "aggregate" | "readIndexIncarnation" | "search"
>;

/** How long a runner transaction waits for the fence or any other lock. */
const ROUTE_PROOF_RUNNER_LOCK_TIMEOUT_MS = 2000;

/** Consecutive failures of one route before the run stops on it. */
const MAX_CONSECUTIVE_FAILURES = 8;
/** Backoff after a route's failure: doubling from this, up to the cap. */
const FAILURE_BACKOFF_MS = 2000;
const FAILURE_BACKOFF_CAP_MS = 120_000;
/** How long a route whose index is missing or unknown waits to be read again. */
const RECHECK_MS = 5 * 60_000;
/** Routes a run walks, and registry rows a family holds: a handful each. */
const ROUTES_MAX = 64;
/** How long a worker with no route due waits before looking again. */
const IDLE_POLL_MS = 50;

/** Why a generation joined the run. */
type CorpusIndexProofRole = "requested" | "serving" | "kept";

type CorpusIndexProofGeneration = {
  family: CorpusFamily;
  generation: string;
  roles: CorpusIndexProofRole[];
};

/** Whether the database takes background work now, after waiting for it. */
type CorpusIndexRouteProofPace =
  { type: "start" } | { type: "braked"; waitedMs: number };

/**
 * The database-load brake of a proof run, read through `readDecision` at
 * most every `recheckMs` (a decision to start is trusted that long, so pages
 * in between pay no load read):
 *
 * - `pace`, before each page: waits until the database takes background
 *   work, or answers `braked` after `maxWaitMs` of waiting, and the run stops;
 * - `admit`, the governor every unit of a page goes through (the page, its
 *   repair): waits the same way, but a unit of a page already paced in is
 *   never abandoned, so after `maxWaitMs` it runs and the next `pace` stops
 *   the run.
 */
export const createCorpusIndexRouteProofBrake = ({
  readDecision,
  maxWaitMs,
  recheckMs,
  now,
  sleep,
}: {
  readDecision: () => Promise<"start" | "wait">;
  maxWaitMs: number;
  recheckMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): {
  pace: () => Promise<CorpusIndexRouteProofPace>;
  admit: CorpusIndexRouteProofAdmission;
} => {
  const admitted = { until: Number.NEGATIVE_INFINITY };
  const pace = async (): Promise<CorpusIndexRouteProofPace> => {
    const startedAt = now();
    while (now() >= admitted.until) {
      const decision = await readDecision();
      if (decision === "start") {
        admitted.until = now() + recheckMs;
        return { type: "start" };
      }
      const waitedMs = now() - startedAt;
      if (waitedMs >= maxWaitMs) {
        return { type: "braked", waitedMs };
      }
      await sleep(Math.min(recheckMs, maxWaitMs - waitedMs));
    }
    return { type: "start" };
  };
  return {
    pace,
    admit: async (_unit, work) => {
      await pace();
      return await work();
    },
  };
};

type GenerationsRefusal = {
  type: "refused";
  generation: string;
  /** The requested generation's registry status; null when unregistered. */
  status: string | null;
};

/**
 * The generations a run proves: the requested one (building or serving),
 * the family's serving generation, and the generation the family's latest
 * flip demoted while it is still building.
 */
const readCorpusIndexProofGenerationsTx = async (
  tx: Transaction,
  { family, generation: requested }: Omit<CorpusIndexRoute, "indexId">,
): Promise<
  | { type: "resolved"; generations: CorpusIndexProofGeneration[] }
  | GenerationsRefusal
> => {
  const registry = await readBounded(
    tx
      .select({
        generation: corpusIndexGenerations.generation,
        status: corpusIndexGenerations.status,
      })
      .from(corpusIndexGenerations)
      .where(eq(corpusIndexGenerations.family, family))
      .orderBy(corpusIndexGenerations.generation),
    ROUTES_MAX,
  );
  const active =
    registry.type === "overflow"
      ? panic(`More generations registered than a family holds: ${family}`)
      : registry.rows;
  const requestedRow = active.find(
    ({ generation }) => generation === requested,
  );
  if (requestedRow === undefined) {
    return { type: "refused", generation: requested, status: null };
  }
  if (
    !CORPUS_INDEX_ACTIVE_GENERATION_STATUSES.some(
      (status) => status === requestedRow.status,
    )
  ) {
    return {
      type: "refused",
      generation: requested,
      status: requestedRow.status,
    };
  }
  const latestFlip = (
    await tx
      .select({ from: corpusIndexGenerationFlips.fromGeneration })
      .from(corpusIndexGenerationFlips)
      .where(eq(corpusIndexGenerationFlips.family, family))
      .orderBy(desc(corpusIndexGenerationFlips.flippedAt))
      .limit(1)
  ).at(0);
  const kept = latestFlip?.from ?? null;
  const joined: { generation: string; role: CorpusIndexProofRole }[] = [
    { generation: requested, role: "requested" },
    ...active.flatMap(
      ({
        generation,
        status,
      }): { generation: string; role: CorpusIndexProofRole }[] => {
        if (status === "serving") {
          return [{ generation, role: "serving" as const }];
        }
        return generation === kept && status === "building"
          ? [{ generation, role: "kept" as const }]
          : [];
      },
    ),
  ];
  const names = [...new Set(joined.map(({ generation }) => generation))];
  return {
    type: "resolved",
    generations: names.map((generation) => ({
      family,
      generation,
      roles: joined
        .filter((entry) => entry.generation === generation)
        .map(({ role }) => role),
    })),
  };
};

/** Read every proven generation's proofs, in one transaction. */
const readProofsTx = async (
  tx: Transaction,
  generations: readonly CorpusIndexProofGeneration[],
): Promise<Map<string, CorpusIndexGenerationRouteProofs>> => {
  const read = new Map<string, CorpusIndexGenerationRouteProofs>();
  for (const target of generations) {
    // db-await-in-loop: one bounded read per generation, at most three
    read.set(target.generation, await readCorpusIndexRouteProofsTx(tx, target));
  }
  return read;
};

const allCurrent = (
  proofs: ReadonlyMap<string, CorpusIndexGenerationRouteProofs>,
): boolean =>
  proofs.size > 0 &&
  [...proofs.values()].every((proof) => proof.type === "all_current");

/** A route set aside for the rest of the run, or until it is read again. */
type SetAside =
  | { type: "refused"; refusal: string }
  | { type: "index_missing"; until: number }
  | { type: "unknown_documents"; documents: number; until: number };

type CorpusIndexRouteProofRouteReport = {
  route: CorpusIndexRoute;
  pages: number;
  proofs: number;
  repairs: number;
  failures: number;
  setAside: SetAside | null;
  /** A failed or refused page waits until this instant before the next. */
  backoffUntil: number;
};

type CorpusIndexRouteProofStop =
  /** Every route of every proven generation is current (`untilCurrent`). */
  | { type: "all_current" }
  /** The run's time or page budget is spent. */
  | { type: "budget_spent" }
  /** The governor gave up waiting on the database's load. */
  | { type: "braked"; waitedMs: number }
  /**
   * Locks stayed refused past the patience: a flip holds the projection
   * fence, or another writer held a lock past the runner's lock timeout.
   */
  | { type: "lock_unavailable"; heldMs: number }
  /** Every route is set aside; nothing is left to walk. */
  | { type: "nothing_to_walk" }
  /** One route failed this many times in a row. */
  | {
      type: "failed";
      route: CorpusIndexRoute;
      failures: number;
      cause: unknown;
    };

export type CorpusIndexRouteProofRun =
  | GenerationsRefusal
  | {
      type: "ran";
      generations: CorpusIndexProofGeneration[];
      stop: CorpusIndexRouteProofStop;
      routes: CorpusIndexRouteProofRouteReport[];
      /** Every proven generation's proofs, read after the last page. */
      proofs: Map<string, CorpusIndexGenerationRouteProofs>;
    };

export type CorpusIndexRouteProofRunOptions = {
  /** A transaction on the runner's own session; the runner fences each. */
  runInTransaction: Runner;
  clientFor: (target: Omit<CorpusIndexRoute, "indexId">) => ProofClient;
  admit: CorpusIndexRouteProofAdmission;
  /** Waits before each page until the database takes background work. */
  pace: () => Promise<CorpusIndexRouteProofPace>;
  target: Omit<CorpusIndexRoute, "indexId">;
  /** The run ends at this instant (`now()`), or after this many pages. */
  budget: { endsAt: number; pages: number };
  /** Stop as soon as every route of every proven generation is current. */
  untilCurrent: boolean;
  /** Routes walked at once; their transactions still run one at a time. */
  concurrency: number;
  /** How long the fence may stay held before the run stops. */
  fencePatienceMs: number;
  /** Revisions per census page; the census default when omitted. */
  pageLimit?: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** One line per event an operator acts on. */
  write: (line: string) => void;
};

/** A transaction that joins the projection fence before its work. */
const fencedRunner =
  (runInTransaction: Runner): Runner =>
  async (work) =>
    await runInTransaction(async (tx) => {
      await setSharedLockTimeout(tx, ROUTE_PROOF_RUNNER_LOCK_TIMEOUT_MS);
      await lockCorpusIndexProjectionWriterTx(tx);
      return await work(tx);
    });

/** A lock the database did not grant in time: the flip's fence, most likely. */
const isLockRefusal = (cause: unknown): boolean =>
  isPgError(cause, PG_ERROR.LOCK_NOT_AVAILABLE) ||
  isPgError(cause, PG_ERROR.DEADLOCK_DETECTED);

const routeName = ({ generation, indexId }: CorpusIndexRoute) =>
  `${generation}/${indexId}`;

type Step =
  | { type: "advanced"; advance: CorpusIndexRouteProofAdvance }
  | { type: "engine_failed"; error: CorpusIndexError }
  | { type: "lock_refused" }
  | { type: "braked"; waitedMs: number }
  | { type: "failed"; cause: unknown };

type RouteReport = CorpusIndexRouteProofRouteReport;

/** What every worker of one run shares. */
type Walk = {
  options: CorpusIndexRouteProofRunOptions;
  runInTransaction: Runner;
  read: Runner;
  generations: readonly CorpusIndexProofGeneration[];
  reports: RouteReport[];
  pages: number;
  stop: CorpusIndexRouteProofStop | null;
  lockRefusedSince: number | null;
  next: number;
  busy: Set<RouteReport>;
};

/** When a route not refused may be walked again (0: now). */
const dueAt = (report: RouteReport): number =>
  Math.max(
    report.backoffUntil,
    report.setAside === null || report.setAside.type === "refused"
      ? 0
      : report.setAside.until,
  );

const walkable = (walk: Walk, report: RouteReport, at: number): boolean => {
  if (report.setAside?.type === "refused") {
    return false;
  }
  return !walk.busy.has(report) && dueAt(report) <= at;
};

/** The next route to walk, round robin, or how long to wait for one. */
const takeRoute = (
  walk: Walk,
):
  | { type: "route"; report: RouteReport }
  | { type: "wait"; ms: number }
  | { type: "none" } => {
  const at = walk.options.now();
  const { reports } = walk;
  for (let offset = 0; offset < reports.length; offset += 1) {
    const index = (walk.next + offset) % reports.length;
    const report = reports[index] ?? panic("Route index out of range");
    if (walkable(walk, report, at)) {
      walk.next = index + 1;
      return { type: "route", report };
    }
  }
  const waits = reports.flatMap((report) =>
    report.setAside?.type === "refused" || walk.busy.has(report)
      ? []
      : [dueAt(report) - at],
  );
  if (waits.length === 0) {
    return walk.busy.size > 0
      ? { type: "wait", ms: IDLE_POLL_MS }
      : { type: "none" };
  }
  return { type: "wait", ms: Math.max(Math.min(...waits), 0) };
};

const stepOf = async (walk: Walk, route: CorpusIndexRoute): Promise<Step> => {
  const { options } = walk;
  const ran = await Result.tryPromise({
    try: async () =>
      await advanceCorpusIndexRouteProof({
        runInTransaction: walk.runInTransaction,
        client: options.clientFor(route),
        admit: options.admit,
        route,
        ...(options.pageLimit === undefined
          ? {}
          : { limit: options.pageLimit }),
      }),
    catch: (cause) => cause,
  });
  if (ran.isErr()) {
    return isLockRefusal(ran.error)
      ? { type: "lock_refused" }
      : { type: "failed", cause: ran.error };
  }
  return ran.value.isErr()
    ? { type: "engine_failed", error: ran.value.error }
    : { type: "advanced", advance: ran.value.value };
};

/** Count a route's failure: back it off, or stop the run after too many. */
const recordFailure = (
  walk: Walk,
  report: RouteReport,
  cause: unknown,
  line: string,
) => {
  report.failures += 1;
  const { failures } = report;
  walk.options.write(
    `  ${routeName(report.route)}: ${line} (${String(failures)} in a row)`,
  );
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    walk.stop ??= { type: "failed", route: report.route, failures, cause };
    return;
  }
  report.backoffUntil =
    walk.options.now() +
    Math.min(FAILURE_BACKOFF_MS * 2 ** (failures - 1), FAILURE_BACKOFF_CAP_MS);
};

/** Record what one page did to its route; true when a proof was made. */
const settle = (
  { now, write }: Pick<CorpusIndexRouteProofRunOptions, "now" | "write">,
  report: RouteReport,
  advance: CorpusIndexRouteProofAdvance,
): boolean => {
  report.failures = 0;
  report.pages += 1;
  const name = routeName(report.route);
  switch (advance.type) {
    case "advanced":
    case "phase_completed":
    case "superseded":
      report.setAside = null;
      return false;
    case "proven":
      report.proofs += 1;
      report.setAside = null;
      write(`  ${name}: proven`);
      return true;
    case "drift_repaired":
      report.repairs += 1;
      write(
        `  ${name}: ${advance.expectation} drift on ${String(advance.repaired)} revisions repaired; the proof is revoked and the pass starts over`,
      );
      return false;
    case "refused":
      report.setAside = {
        type: "refused",
        refusal:
          advance.refusal.type === "unattested"
            ? `unattested (${advance.refusal.reason})`
            : advance.refusal.type,
      };
      write(`  ${name}: set aside, ${report.setAside.refusal}`);
      return false;
    case "index_missing":
      report.setAside = { type: "index_missing", until: now() + RECHECK_MS };
      write(`  ${name}: the engine holds no such index; read again later`);
      return false;
    case "unknown_documents":
      report.setAside = {
        type: "unknown_documents",
        documents: advance.documents,
        until: now() + RECHECK_MS,
      };
      write(
        `  ${name}: PostgreSQL records nothing applied, the index holds ${String(advance.documents)} documents; read again later`,
      );
      return false;
    default:
      advance satisfies never;
      return panic("Unhandled route proof advance");
  }
};

/** Apply one page's step to the run; resolves once its effects are read. */
const applyStep = async (
  walk: Walk,
  report: RouteReport,
  step: Step,
): Promise<void> => {
  const { now } = walk.options;
  if (step.type === "lock_refused") {
    walk.pages -= 1;
    walk.lockRefusedSince ??= now();
    const heldMs = now() - walk.lockRefusedSince;
    if (heldMs >= walk.options.fencePatienceMs) {
      walk.stop ??= { type: "lock_unavailable", heldMs };
      return;
    }
    report.backoffUntil = now() + FAILURE_BACKOFF_MS;
    return;
  }
  walk.lockRefusedSince = null;
  switch (step.type) {
    case "braked":
      walk.stop ??= { type: "braked", waitedMs: step.waitedMs };
      return;
    case "engine_failed":
      recordFailure(
        walk,
        report,
        step.error,
        `engine read failed: ${step.error.message}`,
      );
      return;
    case "failed":
      recordFailure(
        walk,
        report,
        step.cause,
        `page failed: ${step.cause instanceof Error ? step.cause.message : String(step.cause)}`,
      );
      return;
    case "advanced":
      if (
        settle(walk.options, report, step.advance) &&
        walk.options.untilCurrent
      ) {
        const proofs = await walk.read(
          async (tx) => await readProofsTx(tx, walk.generations),
        );
        walk.stop ??= untilCurrentStop(true, proofs);
      }
      return;
    default:
      step satisfies never;
      panic("Unhandled route proof step");
  }
};

/** One worker: take the next due route, walk one page, until the run stops. */
const work = async (walk: Walk): Promise<void> => {
  const { now, sleep, budget } = walk.options;
  while (walk.stop === null) {
    if (now() >= budget.endsAt || walk.pages >= budget.pages) {
      walk.stop = { type: "budget_spent" };
      return;
    }
    const taken = takeRoute(walk);
    if (taken.type === "none") {
      walk.stop = { type: "nothing_to_walk" };
      return;
    }
    if (taken.type === "wait") {
      await sleep(Math.min(taken.ms, Math.max(budget.endsAt - now(), 0)));
      continue;
    }
    const { report } = taken;
    walk.busy.add(report);
    walk.pages += 1;
    const paced = await walk.options.pace();
    const step: Step =
      paced.type === "braked" ? paced : await stepOf(walk, report.route);
    walk.busy.delete(report);
    // db-await-in-loop: a proof's effects are read before the next page
    await applyStep(walk, report, step);
  }
};

const untilCurrentStop = (
  untilCurrent: boolean,
  proofs: ReadonlyMap<string, CorpusIndexGenerationRouteProofs>,
): CorpusIndexRouteProofStop | null =>
  untilCurrent && allCurrent(proofs) ? { type: "all_current" } : null;

/** One report per declared route of every generation that has a route set. */
const routeReports = (
  generations: readonly CorpusIndexProofGeneration[],
  proofs: ReadonlyMap<string, CorpusIndexGenerationRouteProofs>,
  write: (line: string) => void,
): RouteReport[] =>
  generations.flatMap((target) => {
    write(`proving ${target.generation} (${target.roles.join(", ")})`);
    const read =
      proofs.get(target.generation) ?? panic("A generation was not read");
    if (read.type !== "all_current" && read.type !== "not_ready") {
      write(`  ${target.generation}: no route can be proven (${read.type})`);
      return [];
    }
    return read.routes.map(({ indexId }) => ({
      route: { ...target, indexId },
      pages: 0,
      proofs: 0,
      repairs: 0,
      failures: 0,
      setAside: null,
      backoffUntil: 0,
    }));
  });

/**
 * Walk the proofs until the budget ends (`CorpusIndexRouteProofRun`). Safe to
 * run beside another runner on the same routes: every record is a
 * compare-and-set on the pass it read, so the slower one is `superseded`.
 */
export const runCorpusIndexRouteProofs = async (
  options: CorpusIndexRouteProofRunOptions,
): Promise<CorpusIndexRouteProofRun> => {
  const { budget, concurrency } = options;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isSafeInteger(budget.pages) ||
    budget.pages < 0
  ) {
    return panic("Route proof runner budget or concurrency out of range");
  }
  // Pages read and write under the fence; the run's own reports only read.
  const read = options.runInTransaction;
  const resolved = await read(
    async (tx) => await readCorpusIndexProofGenerationsTx(tx, options.target),
  );
  if (resolved.type === "refused") {
    return resolved;
  }
  const { generations } = resolved;
  const initial = await read(async (tx) => await readProofsTx(tx, generations));
  const reports = routeReports(generations, initial, options.write);
  if (reports.length > ROUTES_MAX) {
    return panic("More routes than a run can walk");
  }
  const walk: Walk = {
    options,
    runInTransaction: fencedRunner(options.runInTransaction),
    read,
    generations,
    reports,
    pages: 0,
    stop: untilCurrentStop(options.untilCurrent, initial),
    lockRefusedSince: null,
    next: 0,
    busy: new Set(),
  };
  if (walk.stop === null && reports.length > 0) {
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, reports.length) },
        async () => await work(walk),
      ),
    );
  }
  const proofs = await read(async (tx) => await readProofsTx(tx, generations));
  return {
    type: "ran",
    generations,
    stop: walk.stop ?? { type: "nothing_to_walk" },
    routes: reports,
    proofs,
  };
};
