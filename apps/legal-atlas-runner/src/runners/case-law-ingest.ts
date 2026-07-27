/**
 * Continuous case law ingestion daemon.
 *
 * Each adapter runs in its own independent loop so a slow
 * adapter (e.g. cz-us crawling nalus.usoud.cz) cannot block
 * others from progressing. Cursors are persisted in RDS after
 * each cycle; safe to restart at any time.
 *
 * Per-adapter cycles are capped by MAX_CYCLE_MS (10 min).
 * If an adapter exceeds this, the pipeline aborts gracefully,
 * persists the cursor, and retries next cycle.
 *
 * Usage:
 *   bun --filter @stll/legal-atlas-runner start -- run case-law-ingest [adapter-key]
 *
 * Without arguments, runs all sources in independent loops.
 * With an adapter key, runs only that source once and exits.
 */

import { panic } from "better-result";

import { caseLawIngestionEvents } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { tryRecomputeCitationAuthorityForAll } from "@/api/handlers/case-law/citation-authority";
import { ADAPTER_KEYS, MAX_CYCLE_MS } from "@/api/handlers/case-law/consts";
import { backfillCorpusIndex } from "@/api/handlers/case-law/corpus-index";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import { backfillSearchIndex } from "@/api/handlers/case-law/search-index";
import { backfillLegislationCorpusIndex } from "@/api/handlers/legislation/corpus-index";
import { backfillLegislationSearchIndex } from "@/api/handlers/legislation/search-index";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { corpusGeneration } from "@/api/lib/legal-search/corpus-family";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  isCorpusS3Stale,
  isS3Stale,
  refreshCorpusS3,
  refreshS3,
} from "@/api/lib/s3";

import {
  backfillDb,
  createCaseLawSource,
  findCaseLawSource,
  ingestionDb,
  loadCourtWeightEntries,
} from "../db";
import { LEGAL_ATLAS_RUNNER_ENV } from "../env";
import {
  CYCLE_OUTCOME,
  type CycleOutcome,
  type CycleResult,
  cycleMadeProgress,
  cycleWasIdle,
} from "./cycle-progress";

const formatLogDetail = (detail: unknown): string => {
  if (detail === undefined) {
    return "";
  }

  if (detail instanceof Error) {
    const base = detail.stack ?? detail.message;
    // Wrapped driver errors (e.g. DrizzleQueryError) carry the actual
    // failure in `cause`; without it the log shows only the query text.
    return detail.cause instanceof Error
      ? `${base}\n[cause] ${detail.cause.stack ?? detail.cause.message}`
      : base;
  }

  if (typeof detail === "string") {
    return detail;
  }

  try {
    return JSON.stringify(detail);
  } catch {
    return "[unserializable log detail]";
  }
};

const logInfo = (message: string): void => {
  void Bun.write(Bun.stdout, `${message}\n`);
};

const logError = (message: string, detail?: unknown): void => {
  const formattedDetail = formatLogDetail(detail);
  const line = formattedDetail ? `${message} ${formattedDetail}` : message;
  void Bun.write(Bun.stderr, `${line}\n`);
};

/**
 * Bun's native Postgres pool emits unhandled errors when the
 * server closes a connection (e.g. database failover or
 * network interruption). The internal `#onClose` callback
 * throws a PostgresError that isn't caught by query-level
 * try/catch. Without this handler, the process crashes on
 * any connection drop.
 *
 * A TimeoutError is the same failure class surfacing differently: a
 * connection the server reaped silently never errors, so the bounded
 * DB handle in `../db` rejects the wedged await. Both retry next cycle.
 *
 * Adapter loops already retry on the next cycle, so the
 * daemon self-heals within CYCLE_DELAY_MS (5s).
 */
const isTransientConnectionError = (error: unknown): boolean => {
  if (error instanceof TimeoutError) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("Connection closed") ||
    msg.includes("ERR_POSTGRES_CONNECTION_CLOSED") ||
    msg.includes("PostgresError")
  );
};

/** Set to true once daemon mode starts; single-adapter mode exits on all errors. */
let daemonMode = false;

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (daemonMode && isTransientConnectionError(reason)) {
    logError(`[daemon] DB connection lost (will retry): ${message}`);
    return;
  }
  logError("[daemon] Unhandled rejection:", reason);
  process.exit(1);
});

/**
 * Orchestrator-driven task replacement (a deployment, a rescheduled task)
 * delivers SIGTERM with a bounded kill deadline. Draining finishes the
 * work already in flight but starts nothing new: every write path is
 * checkpointed or content-addressed, so abandoned work is safe, but
 * finishing it avoids redoing the same page on the next start. The
 * force-exit timer ends the process ahead of the orchestrator's SIGKILL
 * even when a loop is mid-sleep on a long interval.
 */
let draining = false;
/** Read via a call so per-site flow analysis cannot misjudge the flag. */
const isDraining = (): boolean => draining;
const DRAIN_FORCE_EXIT_MS = 90_000;

const drainOnSigterm = (): void => {
  process.on("SIGTERM", () => {
    if (isDraining()) {
      return;
    }
    draining = true;
    logInfo("[daemon] SIGTERM received; draining (no new work will start)");
    setTimeout(() => {
      logInfo("[daemon] Drain window elapsed; exiting");
      process.exit(0);
    }, DRAIN_FORCE_EXIT_MS).unref();
  });
};

type SourceDef = {
  adapterKey: string;
  name: string;
};

const HEARTBEAT_PATH = "/tmp/ingestion.lock";
const CYCLE_DELAY_MS = 5000;
const HEALTH_INTERVAL_MS = 30_000;
const SUSTAINED_FAILURE_THRESHOLD = 5;
const SEARCH_INDEX_INTERVAL_MS = 10_000;
const SEARCH_INDEX_BATCH_SIZE = 20;
const SEARCH_INDEX_DRAIN_CONCURRENCY = 4;
const CORPUS_INDEX_INTERVAL_MS = 15_000;
// Citation authority decays slowly; a periodic full recompute keeps the
// materialized ranking signal fresh without per-cycle cost. The first
// recompute runs shortly after startup rather than a full interval in: a
// process whose lifetime is shorter than the interval would otherwise
// never recompute at all. The startup delay keeps a process that exits
// quickly after boot from adding a whole-corpus recompute to every start.
const CITATION_AUTHORITY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CITATION_AUTHORITY_STARTUP_DELAY_MS = 5 * 60 * 1000;
// After a skipped (lock held elsewhere) or failed recompute, retry on a
// short delay instead of waiting a full interval: the holder may have
// exited before committing, and its replacement should not inherit a
// six-hour gap.
const CITATION_AUTHORITY_RETRY_DELAY_MS = 10 * 60 * 1000;

// Idle backoff: once an adapter is caught up (no new decisions
// for IDLE_THRESHOLD consecutive cycles), poll once a day instead
// of every CYCLE_DELAY_MS. Resets to fast cadence on the next
// non-zero insert. Keeps us from hammering court servers in
// steady state.
const IDLE_THRESHOLD = 3;
const IDLE_DELAY_MS = 24 * 60 * 60 * 1000;

// Liveness watchdog. A self-scheduling timer measures how late it fires
// versus its interval; sustained lag means the event loop is starved (a
// runaway cycle or a wedged connection pool) and the daemon is making no
// progress. After enough consecutive starved ticks it exits so ECS can
// relaunch a fresh task, instead of sitting alive-but-stuck forever (the
// per-adapter retry/backoff only recovers from *thrown* errors, not from
// awaits that never settle). Thresholds are well above any healthy pause:
// idle adapters keep the loop responsive, so lag stays near zero.
const WATCHDOG_TICK_MS = 10_000;
const WATCHDOG_LAG_THRESHOLD_MS = 90_000;
const WATCHDOG_MAX_STARVED_TICKS = 3;

/**
 * A single tick this far behind is conclusive on its own.
 *
 * Consecutive starved ticks only detect a loop that stays blocked
 * across several tick intervals. One long synchronous block does the
 * opposite: it delivers no tick at all while it runs, then exactly one
 * very late tick, after which the loop is idle and the next tick is
 * punctual — so the streak resets and never reaches the limit. A
 * runaway that freezes the daemon for half an hour at a time is
 * therefore invisible to the streak, which is the shape this ceiling
 * catches.
 */
const WATCHDOG_FATAL_LAG_MS = 300_000;

// Hard wall-clock ceiling on a single held cycle. The lag watchdog catches a
// CPU-starved loop, but a cycle wedged on an await that ignores the per-cycle
// signal (e.g. a DB call before/after the pipeline's AbortSignal) leaves the
// loop responsive AND keeps its concurrency slot, which would park every other
// adapter. If a cycle outlives this ceiling — well above the longest adapter
// maxCycleMs (30m) plus slack — the worker is wedged: exit so ECS relaunches.
const CYCLE_HARD_DEADLINE_MS = 45 * 60 * 1000;
const BACKFILL_DEADLINE_TRANSACTION_GRACE_MS = 60_000;

// Hard wall-clock backstop for one backfill batch (the corpus-index and
// search-index loops). Every external await inside a batch is individually
// bounded — corpus S3 reads via the corpus-storage ceiling, the database via
// the dedicated backfill transaction handle in ../db (statement_timeout +
// wall-clock grace), the corpus-index engine via its own HTTP request
// timeout — so this is a pure backstop: it guards against any FUTURE
// unbounded await slipping into a batch, where the batch would never return
// and the loop would stop making progress silently while the event loop
// stays responsive (invisible to the lag watchdog). Sizing basis: the
// realistic worst case of a fully-bounded batch is batch size × per-item
// bounded I/O over the drain concurrency (e.g. 20 items drained 4 at a
// time, reads bounded at a minute each) plus a handful of bounded DB
// transactions. 45 minutes — matching the adapter cycle's ceiling — sits far
// above that with headroom, so it never fires on a merely-slow batch while a
// genuine wedge still exits within a bounded window.
const BACKFILL_HARD_DEADLINE_MS = 45 * 60 * 1000;
const SEARCH_INDEX_HARD_DEADLINE_MS = Math.max(
  BACKFILL_HARD_DEADLINE_MS,
  Math.ceil(SEARCH_INDEX_BATCH_SIZE / SEARCH_INDEX_DRAIN_CONCURRENCY) *
    (LEGAL_ATLAS_RUNNER_ENV.dbBackfillTransactionTimeoutMs +
      BACKFILL_DEADLINE_TRANSACTION_GRACE_MS),
);

type Semaphore = {
  acquire: (signal?: AbortSignal) => Promise<void>;
  release: () => void;
};

/**
 * Fair counting semaphore: bounds how many holders run concurrently and
 * hands the slot to the longest-waiting acquirer on release. An optional
 * abort signal removes a pending waiter and rejects with AbortError.
 */
const createSemaphore = (label: string, capacity: number): Semaphore => {
  const max = Math.max(1, capacity);
  let active = 0;
  const queue: (() => void)[] = [];

  const acquire = async (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) {
      throw new DOMException(`${label} acquisition aborted`, "AbortError");
    }
    if (active < max) {
      active++;
      await Promise.resolve();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const entry = () => {
        signal?.removeEventListener("abort", onAbort);
        active++;
        resolve();
      };
      const onAbort = () => {
        const idx = queue.indexOf(entry);
        if (idx !== -1) {
          queue.splice(idx, 1);
        }
        reject(new DOMException(`${label} acquisition aborted`, "AbortError"));
      };
      queue.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const release = (): void => {
    if (active === 0) {
      panic(`${label} semaphore released without an active acquisition`);
    }
    active--;
    const next = queue.shift();
    if (next) {
      return next();
    }
  };

  return { acquire, release };
};

/**
 * Max adapters doing DB-heavy work (insert + search index +
 * citation extraction) simultaneously. The pipeline acquires
 * a slot before processing decisions and releases it before
 * the next external API fetch, so court API I/O runs freely
 * in parallel while DB pressure is capped.
 */
const MAX_CONCURRENT_DB_WRITES = Math.max(
  1,
  LEGAL_ATLAS_RUNNER_ENV.maxConcurrentDbWrites,
);
const dbWriteSemaphore = createSemaphore("DB slot", MAX_CONCURRENT_DB_WRITES);

/**
 * Max adapter cycles running concurrently. Unlike the DB-write slot, this
 * also covers the fetch + finaldoc-enrich + AST-parse phase, which is
 * CPU-heavy and otherwise unbounded: every source would crawl its backlog
 * at once and saturate a small worker, so no page completes within its
 * cycle budget. Bounding cycles lets a few sources make real progress and
 * advance their cursors instead of collapsing under N-way contention.
 */
const MAX_CONCURRENT_ADAPTER_CYCLES = Math.max(
  1,
  LEGAL_ATLAS_RUNNER_ENV.maxConcurrentAdapterCycles,
);
const cycleSemaphore = createSemaphore(
  "adapter cycle",
  MAX_CONCURRENT_ADAPTER_CYCLES,
);

/** Adapter keys holding a cycle slot right now. */
const inFlightCycles = new Set<string>();

/**
 * Adapter keys that have held a cycle slot since the watchdog last
 * looked, cleared only by the watchdog itself.
 *
 * The in-flight set alone cannot attribute a stall. A synchronous block
 * ends before any timer runs, so the cycle's own cleanup — a microtask —
 * removes its key first, and the watchdog callback, a macrotask, then
 * sees an empty set and reports the very thing it exists to identify as
 * "none". Accumulating until the watchdog drains it keeps the culprit
 * visible even though it finished during the freeze.
 */
const cyclesSinceWatchdogTick = new Set<string>();

const writeHeartbeat = () => {
  void Bun.write(HEARTBEAT_PATH, new Date().toISOString()).catch(() => {
    // Non-fatal; health check will notice staleness
  });
};

/**
 * Start the event-loop liveness watchdog (daemon mode only). Self-schedules
 * every WATCHDOG_TICK_MS and compares actual delay to the expected interval;
 * each tick whose lag exceeds WATCHDOG_LAG_THRESHOLD_MS counts as starved,
 * and WATCHDOG_MAX_STARVED_TICKS in a row triggers a process exit so ECS
 * relaunches a healthy task. A single fast tick clears the streak.
 */
const startEventLoopWatchdog = (): void => {
  let starvedTicks = 0;
  let expectedAt = performance.now() + WATCHDOG_TICK_MS;

  const tick = () => {
    const lag = performance.now() - expectedAt;
    if (lag > WATCHDOG_LAG_THRESHOLD_MS) {
      starvedTicks++;
      // Whatever held a cycle slot across the stall is the prime
      // suspect: nothing else was running. Without this the log shows
      // only the lag, and the adapters whose timers fired late on
      // recovery look like the cause rather than the casualties.
      // Joined rather than an array: log attributes are scalars.
      const suspects = new Set([...cyclesSinceWatchdogTick, ...inFlightCycles]);
      const inFlight = [...suspects].join(",");
      logger.error("case_law.ingestion.event_loop_starved", {
        lagMs: Math.round(lag),
        starvedTicks,
        inFlightCycles: inFlight,
      });
      logError(
        `[watchdog] event loop starved: lag=${Math.round(lag)}ms ` +
          `(${starvedTicks}/${WATCHDOG_MAX_STARVED_TICKS}) ` +
          `in-flight: ${inFlight || "none"}`,
      );
      if (lag > WATCHDOG_FATAL_LAG_MS) {
        logError(
          `[watchdog] single block exceeded ${WATCHDOG_FATAL_LAG_MS}ms; ` +
            "exiting for ECS restart",
        );
        process.exit(1);
      }
      if (starvedTicks >= WATCHDOG_MAX_STARVED_TICKS) {
        logError(
          "[watchdog] sustained event-loop starvation; exiting for ECS restart",
        );
        process.exit(1);
      }
    } else {
      starvedTicks = 0;
    }
    // Drained every tick, so the next report names only cycles that ran
    // within the window it measured.
    cyclesSinceWatchdogTick.clear();
    expectedAt = performance.now() + WATCHDOG_TICK_MS;
    // unref: the watchdog observes the loop, it must not be the sole handle
    // keeping the process alive once everything else has finished.
    setTimeout(tick, WATCHDOG_TICK_MS).unref();
  };

  setTimeout(tick, WATCHDOG_TICK_MS).unref();
};

/**
 * Run one loop iteration under a hard wall-clock backstop. The lag watchdog
 * only catches a CPU-starved event loop; an await wedged on I/O-wait (a stalled
 * socket that never settles) keeps the loop responsive yet parks the loop's
 * forward progress forever. Bounding each iteration guarantees such a wedge
 * eventually exits the task so ECS relaunches a healthy one, instead of a
 * silent, indefinite freeze. The timer is unref'd so it never keeps the process
 * alive on its own, and cleared once the iteration settles. This is the same
 * mechanism the adapter cycle uses, shared so every daemon loop is covered.
 */
const runWithHardDeadline = async <T>(
  label: string,
  deadlineMs: number,
  operation: () => Promise<T>,
): Promise<T> => {
  const deadline = setTimeout(() => {
    logError(
      `[${label}] iteration exceeded ${deadlineMs}ms hard deadline (wedged await); exiting for ECS restart`,
    );
    process.exit(1);
  }, deadlineMs);
  deadline.unref();
  try {
    return await operation();
  } finally {
    clearTimeout(deadline);
  }
};

// Adapters to skip. Set DISABLED_ADAPTERS env var to a
// comma-separated list of adapter keys (e.g. "sk-courts,pl-courts").
const DISABLED_ADAPTER_KEYS = new Set(
  LEGAL_ATLAS_RUNNER_ENV.disabledAdapters.split(",").flatMap((k) => {
    const trimmed = k.trim();
    return trimmed ? [trimmed] : [];
  }),
);

// AT_COURTS excluded: adapter exists but has not been
// validated in production yet.
const ALL_SOURCES: SourceDef[] = [
  {
    adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
    name: "Czech Regional Courts",
  },
  {
    adapterKey: ADAPTER_KEYS.CZ_NS,
    name: "Czech Supreme Court",
  },
  {
    adapterKey: ADAPTER_KEYS.CZ_NSS,
    name: "Czech Supreme Administrative Court",
  },
  {
    adapterKey: ADAPTER_KEYS.CZ_US,
    name: "Czech Constitutional Court",
  },
  {
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    name: "Slovak Courts",
  },
  {
    adapterKey: ADAPTER_KEYS.SK_US,
    name: "Slovak Constitutional Court",
  },
  {
    adapterKey: ADAPTER_KEYS.PL_COURTS,
    name: "Polish Courts (SAOS)",
  },
  {
    adapterKey: ADAPTER_KEYS.EU_ECJ,
    name: "Court of Justice of the EU (CJEU)",
  },
];

const SOURCES = ALL_SOURCES.filter(
  (s) => !DISABLED_ADAPTER_KEYS.has(s.adapterKey),
);

if (DISABLED_ADAPTER_KEYS.size > 0) {
  logInfo(`Disabled adapters: ${[...DISABLED_ADAPTER_KEYS].join(", ")}`);
}

const ensureSource = async (
  adapterKey: string,
  name: string,
  initialCursor: string | null,
) => {
  const existing = await findCaseLawSource(adapterKey);

  if (existing) {
    return existing;
  }

  const created = await createCaseLawSource({
    adapterKey,
    name,
    syncCursor: initialCursor,
  });

  if (!created) {
    panic(`Failed to create source row for adapter "${adapterKey}"`);
  }

  return created;
};

const daysAgoCursor = (n: number): string => {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const date = d.toISOString().split("T")[0];
  if (!date) {
    panic("Invalid date format");
  }
  return date;
};

/**
 * Run a single ingestion cycle for one adapter.
 * "timeout" means the cycle hit MAX_CYCLE_MS but progress
 * was made (cursor advanced) — not a true failure.
 */
type CycleBounds = {
  maxPages?: number | undefined;
  maxDecisions?: number | undefined;
};

const runOneCycle = async (
  adapterKey: string,
  name: string,
  bounds: CycleBounds = {},
): Promise<CycleResult> => {
  const initialCursor =
    adapterKey === ADAPTER_KEYS.CZ_REGIONAL ? daysAgoCursor(7) : null;

  const source = await ensureSource(adapterKey, name, initialCursor);
  const cursorBefore = source.syncCursor;

  logInfo(`[${adapterKey}] Ingesting (cursor: ${cursorBefore ?? "start"})`);

  const startedAt = new Date();
  const t0 = performance.now();

  let outcome: CycleOutcome = CYCLE_OUTCOME.COMPLETED;
  let errorMessage: string | null = null;
  let result: Awaited<ReturnType<typeof runIngestionPipeline>> | null = null;

  try {
    const adapter = getAdapter(adapterKey);
    const cycleMs = adapter?.maxCycleMs ?? MAX_CYCLE_MS;

    result = await runIngestionPipeline({
      source,
      scopedDb: ingestionDb,
      dbSlot: dbWriteSemaphore,
      signal: AbortSignal.timeout(cycleMs),
      ...(bounds.maxPages !== undefined && { maxPages: bounds.maxPages }),
      ...(bounds.maxDecisions !== undefined && {
        maxDecisions: bounds.maxDecisions,
      }),
    });
    if (result.haltReason?.startsWith("Decision cap")) {
      // A requested sample bound is a successful outcome, not a failure.
      logInfo(`[${adapterKey}] ${result.haltReason}`);
    } else if (result.haltReason) {
      outcome =
        result.haltReason === "Cycle timeout exceeded"
          ? CYCLE_OUTCOME.TIMEOUT
          : CYCLE_OUTCOME.FAILED;
      errorMessage = result.haltReason.slice(0, 2048);
    }
  } catch (error) {
    outcome = CYCLE_OUTCOME.FAILED;
    errorMessage =
      `[${errorTag(error)}] ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        2048,
      );
  }

  const durationMs = Math.round(performance.now() - t0);

  // DB status column only supports "completed" | "failed";
  // timeouts are recorded as "completed" (progress was made).
  const dbStatus = outcome === CYCLE_OUTCOME.FAILED ? "failed" : "completed";

  try {
    await ingestionDb(async (tx) => {
      await tx.insert(caseLawIngestionEvents).values({
        sourceId: source.id,
        status: dbStatus,
        inserted: result?.inserted ?? 0,
        skipped: result?.skipped ?? 0,
        searchVectorFailures: result?.searchVectorFailures ?? 0,
        pagesProcessed: result?.pagesProcessed ?? 0,
        cursorBefore,
        cursorAfter: result !== null ? result.nextCursor : cursorBefore,
        durationMs,
        errorMessage,
        startedAt,
      });
    });
  } catch (eventError) {
    logError(`[${adapterKey}] Failed to write ingestion event:`, eventError);
  }

  if (outcome === CYCLE_OUTCOME.COMPLETED) {
    logInfo(
      `[${adapterKey}] Inserted: ${result?.inserted ?? 0}, ` +
        `Skipped: ${result?.skipped ?? 0}, ` +
        `Pages: ${result?.pagesProcessed ?? 0}, ` +
        `Duration: ${durationMs}ms`,
    );
  } else if (outcome === CYCLE_OUTCOME.TIMEOUT) {
    logInfo(
      `[${adapterKey}] Timed out after ${durationMs}ms ` +
        `(inserted: ${result?.inserted ?? 0}, pages: ${result?.pagesProcessed ?? 0})`,
    );
  } else {
    logError(`[${adapterKey}] Failed: ${errorMessage}`);
  }

  return {
    outcome,
    inserted: result?.inserted ?? 0,
    pagesProcessed: result?.pagesProcessed ?? 0,
  };
};

/**
 * Independent loop for a single adapter. Runs forever,
 * catching all errors so it never crashes.
 */

const runAdapterLoop = async ({ adapterKey, name }: SourceDef) => {
  /**
   * Consecutive cycles that advanced no page, whatever their outcome (see
   * `cycleMadeProgress`). A single streak so an adapter alternating between
   * stall shapes, each of which would otherwise reset the other's counter,
   * still reaches the sustained-failure alert.
   */
  let noProgressStreak = 0;
  /** Separate counter for backoff; not reset by the alert threshold. */
  let backoffFailures = 0;
  /** Consecutive completed cycles with zero inserts; drives idle backoff. */
  let idleCycles = 0;

  while (true) {
    if (isDraining()) {
      return;
    }
    try {
      // Bound concurrent cycles: the fetch/enrich/parse phase runs outside
      // the DB-write slot, so without this every source crawls its backlog
      // at once and saturates the worker. Held only for the cycle and
      // released before the inter-cycle delay, so idle adapters free the slot.
      // oxlint-disable-next-line no-await-in-loop -- continuous daemon: one cycle at a time per adapter so the persisted cursor advances in order
      await cycleSemaphore.acquire();
      // A loop that queued on acquire() passed the drain check before the
      // signal arrived; hand the slot back instead of starting a new cycle.
      if (isDraining()) {
        cycleSemaphore.release();
        return;
      }
      let cycle: CycleResult;
      // Hard wall-clock backstop on the held slot. runOneCycle has awaits that
      // ignore the per-cycle abort signal (the source lookup before it is
      // created, the event write after the pipeline); if one wedges on a
      // broken connection the cycle never returns and the slot parks every
      // other adapter. The lag watchdog can't see an I/O-wait hang (the loop
      // stays responsive), so bound it here: if a cycle outlives the ceiling,
      // exit so ECS relaunches a healthy task.
      inFlightCycles.add(adapterKey);
      cyclesSinceWatchdogTick.add(adapterKey);
      try {
        // oxlint-disable-next-line no-await-in-loop -- continuous daemon: one cycle at a time per adapter so the persisted cursor advances in order
        cycle = await runWithHardDeadline(
          adapterKey,
          CYCLE_HARD_DEADLINE_MS,
          async () => await runOneCycle(adapterKey, name),
        );
      } finally {
        inFlightCycles.delete(adapterKey);
        cycleSemaphore.release();
      }
      const { outcome } = cycle;

      // A stall is a cycle that advanced no page, whatever its outcome; a halt
      // or a timeout that still walked pages moved the cursor.
      const madeProgress = cycleMadeProgress(cycle);
      noProgressStreak = madeProgress ? 0 : noProgressStreak + 1;

      if (outcome === CYCLE_OUTCOME.FAILED && !madeProgress) {
        backoffFailures++;
      } else {
        backoffFailures = 0;
        // Idle means caught up with nothing to do, so only a clean cycle that
        // found nothing counts toward it. Every other cycle reaching here
        // moved through the source, and a halt or a timeout partway in is a
        // source with work left rather than a quiet one: it has to clear the
        // idle state, or the delay below parks a working adapter on the daily
        // cadence for a day at a time.
        if (cycleWasIdle(cycle)) {
          idleCycles++;
          if (idleCycles === IDLE_THRESHOLD) {
            logInfo(`[${adapterKey}] Caught up; switching to daily polling`);
          }
        } else {
          if (idleCycles >= IDLE_THRESHOLD) {
            logInfo(
              `[${adapterKey}] New decisions found; resuming fast cadence`,
            );
          }
          idleCycles = 0;
        }
      }
    } catch (error) {
      // A thrown cycle made no forward progress either.
      noProgressStreak++;
      backoffFailures++;
      const msg = error instanceof Error ? error.message : String(error);
      if (isTransientConnectionError(error)) {
        logError(`[${adapterKey}] DB connection error (will retry): ${msg}`);
      } else {
        logError(`[${adapterKey}] Unexpected error:`, error);
      }
    }

    // A run of cycles that advanced no page means the source is stalled;
    // surface it on the sustained-failure metric.
    if (noProgressStreak >= SUSTAINED_FAILURE_THRESHOLD) {
      logger.error("case_law.ingestion.sustained_failure", {
        adapterKey,
        noProgressStreak,
      });
      // Reset to avoid flooding; backoffFailures stays high so the delay
      // doesn't collapse. The value is read again at the top of the next
      // iteration (`noProgressStreak + 1`).
      noProgressStreak = 0;
    }

    writeHeartbeat();
    // Failure backoff wins when active (5s, 10s, 20s, 40s, cap 60s).
    // Otherwise: idle delay if caught up, else fast cadence.
    let delayMs: number;
    if (backoffFailures > 0) {
      delayMs = Math.min(CYCLE_DELAY_MS * 2 ** backoffFailures, 60_000);
    } else if (idleCycles >= IDLE_THRESHOLD) {
      delayMs = IDLE_DELAY_MS;
    } else {
      delayMs = CYCLE_DELAY_MS;
    }
    // oxlint-disable-next-line no-await-in-loop -- inter-cycle backoff/idle delay; the loop must pause before the next cycle, so this await is intentionally sequential
    await Bun.sleep(delayMs);
  }
};

type IngestCliArgs = {
  filterKey: string | undefined;
  maxPages: number | undefined;
  maxDecisions: number | undefined;
};

const parseIngestArgs = (argv: readonly string[]): IngestCliArgs | null => {
  const args: IngestCliArgs = {
    filterKey: undefined,
    maxPages: undefined,
    maxDecisions: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--max-pages" || arg === "--max-decisions") {
      const parsed = Number(argv[i + 1]);
      if (!Number.isInteger(parsed) || parsed < 1) {
        logError(`${arg} requires a positive integer`);
        return null;
      }
      if (arg === "--max-pages") {
        args.maxPages = parsed;
      } else {
        args.maxDecisions = parsed;
      }
      i += 1;
      continue;
    }
    if (arg !== undefined && !arg.startsWith("--") && !args.filterKey) {
      args.filterKey = arg;
      continue;
    }
    logError(`Unknown option: ${arg ?? "(missing)"}`);
    return null;
  }
  return args;
};

export const runCaseLawIngest = async (
  argv: readonly string[],
): Promise<number> => {
  const parsed = parseIngestArgs(argv);
  if (parsed === null) {
    return 64;
  }
  const { filterKey, maxPages, maxDecisions } = parsed;

  if ((maxPages !== undefined || maxDecisions !== undefined) && !filterKey) {
    logError(
      "--max-pages/--max-decisions require an adapter key (bounded sample runs are single-adapter)",
    );
    return 64;
  }

  // Single adapter: run once and exit (useful for debugging and for
  // bounded staging sample runs).
  if (filterKey) {
    const match = SOURCES.find((s) => s.adapterKey === filterKey);
    if (!match) {
      logError(
        `Unknown adapter: ${filterKey}. ` +
          `Valid keys: ${SOURCES.map((s) => s.adapterKey).join(", ")}`,
      );
      return 1;
    }
    // Independent: separate S3 clients (distinct module-level vars in
    // apps/api/src/lib/s3.ts), no shared state. runOneCycle depends on
    // both completing first, so it stays sequential after.
    await Promise.all([refreshS3(), refreshCorpusS3()]);
    const { outcome } = await runOneCycle(match.adapterKey, match.name, {
      maxPages,
      maxDecisions,
    });
    return outcome === "completed" ? 0 : 1;
  }

  if (SOURCES.length === 0) {
    logError("No adapters enabled. Check DISABLED_ADAPTERS env var.");
    return 1;
  }

  // All adapters: independent concurrent loops.
  daemonMode = true;
  drainOnSigterm();
  logInfo("Ingestion daemon started.");
  startEventLoopWatchdog();
  await refreshS3();
  await refreshCorpusS3();
  writeHeartbeat();

  const adapterLoops: Promise<void>[] = [];
  for (const source of SOURCES) {
    adapterLoops.push(runAdapterLoop(source));
  }

  // Health loop: heartbeat + S3 credential refresh.
  const healthLoop = (async () => {
    while (true) {
      if (isDraining()) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- fixed-interval health poll; the loop must wait HEALTH_INTERVAL_MS between heartbeats, so this await is intentionally sequential
      await Bun.sleep(HEALTH_INTERVAL_MS);
      if (isDraining()) {
        return;
      }
      writeHeartbeat();
      try {
        if (isS3Stale()) {
          // oxlint-disable-next-line no-await-in-loop -- credential refresh per poll cycle; must complete before the loop sleeps and re-checks staleness
          await refreshS3();
        }
        if (isCorpusS3Stale()) {
          // oxlint-disable-next-line no-await-in-loop -- credential refresh per poll cycle; must complete before the loop sleeps and re-checks staleness
          await refreshCorpusS3();
        }
      } catch (error) {
        logError("S3 credential refresh failed:", error);
      }
    }
  })();

  // Search index backfill loop: indexes decisions that were
  // inserted without a tsvector (the pipeline no longer computes
  // tsvectors inline). Runs at low priority outside the DB slot
  // semaphore with bounded concurrency and a generous statement
  // timeout so long texts don't block other work.
  const searchIndexLoop = (async () => {
    while (true) {
      if (isDraining()) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- fixed-interval backfill poll; the loop must wait SEARCH_INDEX_INTERVAL_MS between batches, so this await is intentionally sequential
      await Bun.sleep(SEARCH_INDEX_INTERVAL_MS);
      if (isDraining()) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one bounded backfill batch per interval; the next poll only runs after this batch completes
        const indexed = await runWithHardDeadline(
          "search-index",
          SEARCH_INDEX_HARD_DEADLINE_MS,
          async () =>
            await backfillSearchIndex(backfillDb, SEARCH_INDEX_BATCH_SIZE),
        );
        if (indexed > 0) {
          logInfo(`[search-index] Indexed ${indexed} decisions (backfill)`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isTransientConnectionError(error)) {
          logError(`[search-index] DB connection error (will retry): ${msg}`);
        } else {
          logError("[search-index] Backfill error:", error);
        }
      }
    }
  })();

  // Citation-authority refresh loop: keeps the materialized ranking
  // signal current (also runs in the post-citation pass; this covers the
  // continuous daemon). Runs via the ingestion role outside the DB slot.
  // The try-locked recompute makes overlapping processes (a rolling
  // deployment) skip instead of queueing duplicate whole-corpus updates.
  const citationAuthorityLoop = (async () => {
    await Bun.sleep(CITATION_AUTHORITY_STARTUP_DELAY_MS);
    while (true) {
      if (isDraining()) {
        return;
      }
      let recomputed = false;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one full recompute per interval; the next poll only runs after this recompute completes
        const courtWeightEntries = await loadCourtWeightEntries();
        // oxlint-disable-next-line no-await-in-loop -- one full recompute per interval; the next poll only runs after this recompute completes
        const updated = await ingestionDb(async (tx) => {
          const count = await tryRecomputeCitationAuthorityForAll(tx, {
            courtWeightEntries,
          });
          return count;
        });
        if (updated === null) {
          logInfo(
            "[citation-authority] Skipped (recompute already running in another process)",
          );
        } else {
          recomputed = true;
          logInfo(
            `[citation-authority] Recomputed (${updated} cited decisions)`,
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isTransientConnectionError(error)) {
          logError(
            `[citation-authority] DB connection error (will retry): ${msg}`,
          );
        } else {
          logError("[citation-authority] Recompute error:", error);
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- fixed-interval recompute poll; the loop must wait between recomputes, so this await is intentionally sequential
      await Bun.sleep(
        recomputed
          ? CITATION_AUTHORITY_INTERVAL_MS
          : CITATION_AUTHORITY_RETRY_DELAY_MS,
      );
    }
  })();

  // corpus index index backfill loop: pushes corpus-backed decisions into the
  // active generation. Gated so the index can warm up (and be benchmarked)
  // while search still reads pg-fts; runs outside the DB slot semaphore.
  const corpusIndexLoop = (async () => {
    if (!envBase.CORPUS_INDEXING_ENABLED) {
      return;
    }
    const generation = envBase.LEGAL_SEARCH_INDEX_GENERATION;
    logInfo(`[corpus-index] Enabled for generation ${generation}`);
    while (true) {
      if (isDraining()) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- fixed-interval backfill poll; the loop must wait CORPUS_INDEX_INTERVAL_MS between batches, so this await is intentionally sequential
      await Bun.sleep(CORPUS_INDEX_INTERVAL_MS);
      if (isDraining()) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one bounded backfill batch per interval; the next poll only runs after this batch completes
        const indexed = await runWithHardDeadline(
          "corpus-index",
          BACKFILL_HARD_DEADLINE_MS,
          async () =>
            await backfillCorpusIndex(
              backfillDb,
              LIMITS.corpusIndexBatchSize,
              generation,
            ),
        );
        if (indexed > 0) {
          logInfo(`[corpus-index] Indexed ${indexed} decisions`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isTransientConnectionError(error)) {
          logError(`[corpus-index] DB connection error (will retry): ${msg}`);
        } else {
          logError("[corpus-index] Backfill error:", error);
        }
      }
    }
  })();

  // Legislation pg-fts projection loop (mirrors searchIndexLoop). The
  // corpus daemon maintains both families' search projections.
  const legislationSearchIndexLoop = (async () => {
    while (true) {
      if (isDraining()) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- fixed-interval backfill poll; the loop must wait SEARCH_INDEX_INTERVAL_MS between batches, so this await is intentionally sequential
      await Bun.sleep(SEARCH_INDEX_INTERVAL_MS);
      if (isDraining()) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one bounded backfill batch per interval; the next poll only runs after this batch completes
        const indexed = await runWithHardDeadline(
          "legislation-search-index",
          SEARCH_INDEX_HARD_DEADLINE_MS,
          async () =>
            await backfillLegislationSearchIndex(
              backfillDb,
              SEARCH_INDEX_BATCH_SIZE,
            ),
        );
        if (indexed > 0) {
          logInfo(`[legislation-search-index] Indexed ${indexed} documents`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isTransientConnectionError(error)) {
          logError(
            `[legislation-search-index] DB connection error (will retry): ${msg}`,
          );
        } else {
          logError("[legislation-search-index] Backfill error:", error);
        }
      }
    }
  })();

  // Legislation corpus index index loop (mirrors corpusIndexLoop), gated.
  const legislationCorpusIndexLoop = (async () => {
    if (!envBase.CORPUS_INDEXING_ENABLED) {
      return;
    }
    const generation = corpusGeneration("legislation");
    logInfo(`[legislation-corpus-index] Enabled for generation ${generation}`);
    while (true) {
      if (isDraining()) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- fixed-interval backfill poll; the loop must wait CORPUS_INDEX_INTERVAL_MS between batches, so this await is intentionally sequential
      await Bun.sleep(CORPUS_INDEX_INTERVAL_MS);
      if (isDraining()) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one bounded backfill batch per interval; the next poll only runs after this batch completes
        const indexed = await runWithHardDeadline(
          "legislation-corpus-index",
          BACKFILL_HARD_DEADLINE_MS,
          async () =>
            await backfillLegislationCorpusIndex(
              backfillDb,
              LIMITS.corpusIndexBatchSize,
              generation,
            ),
        );
        if (indexed > 0) {
          logInfo(`[legislation-corpus-index] Indexed ${indexed} documents`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isTransientConnectionError(error)) {
          logError(
            `[legislation-corpus-index] DB connection error (will retry): ${msg}`,
          );
        } else {
          logError("[legislation-corpus-index] Backfill error:", error);
        }
      }
    }
  })();

  await Promise.all([
    ...adapterLoops,
    healthLoop,
    searchIndexLoop,
    citationAuthorityLoop,
    corpusIndexLoop,
    legislationSearchIndexLoop,
    legislationCorpusIndexLoop,
  ]);
  return 0;
};
