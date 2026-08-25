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

import { DAY_IN_MS } from "@stll/time";

import { SOURCE_TOTAL_ORIGIN, caseLawIngestionEvents } from "@/api/db/schema";
import { corpusStorageMode, envBase } from "@/api/env-base";
import {
  hasResolvedCitations,
  tryRecomputeCitationAuthorityBatch,
} from "@/api/handlers/case-law/citation-authority";
import {
  countPendingCitations,
  tryResolveCitationBatch,
} from "@/api/handlers/case-law/citation-resolution";
import { ADAPTER_KEYS, MAX_CYCLE_MS } from "@/api/handlers/case-law/consts";
import {
  BACKFILL_STATUS,
  backfillCorpusIndex,
} from "@/api/handlers/case-law/corpus-index";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import type { SliceRetrySchedule } from "@/api/handlers/case-law/ingestion/reconciliation-engine";
import {
  RECONCILIATION_INGEST_BUDGET_MS,
  RECONCILIATION_LISTING_WORST_CASE_MS,
  RECONCILIATION_UNIT_SETTLE_MS,
  runReconciliationWorkUnit,
} from "@/api/handlers/case-law/ingestion/reconciliation-engine";
import {
  readSourceReportedTotals,
  setSourceReportedTotal,
} from "@/api/handlers/case-law/ingestion/source-totals";
import { backfillLegislationCorpusIndex } from "@/api/handlers/legislation/corpus-index";
import { backfillLegislationSearchIndex } from "@/api/handlers/legislation/search-index";
import { captureError } from "@/api/lib/analytics/capture";
import {
  createCaseLawCensus,
  createCaseLawCorpusIndexCountSeed,
} from "@/api/lib/corpus-index/census";
import { IngestionStallError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { backfillSearchIndex } from "@/api/lib/legal-search/case-law-search-index";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { corpusGeneration } from "@/api/lib/legal-search/corpus-family";
import {
  DOCUMENT_FETCH_BUDGET_MS,
  fetchDecisionDocument,
  scopedPendingDocumentTierLoaders,
} from "@/api/lib/legal-search/sk-document-backfill";
import { createPendingDocumentQueue } from "@/api/lib/legal-search/sk-document-queue";
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
  RECONCILIATION_LOOP_TIMING,
  RECONCILIATION_TURN,
  type ReconciliationSource,
  runCaseLawReconciliationLoop,
} from "./case-law-reconciliation";
import {
  CITATION_RESOLUTION_DRAIN_TIMING,
  CITATION_RESOLUTION_STEP,
  type CitationResolutionStep,
  runCitationResolutionDrain,
} from "./citation-resolution-drain";
import {
  CORPUS_INDEX_STEP,
  type CorpusIndexStepKind,
  type CorpusIndexStreaks,
  INITIAL_CORPUS_INDEX_STREAKS,
  corpusIndexStallThreshold,
  stepCorpusIndexProgress,
} from "./corpus-index-progress";
import {
  CYCLE_CADENCE,
  CYCLE_CADENCE_DELAY_MS,
  CYCLE_OUTCOME,
  type CadenceStreaks,
  type CycleCadence,
  type CycleOutcome,
  type CycleResult,
  INITIAL_CADENCE_STREAKS,
  INITIAL_STALL_ALERT,
  type StallAlertState,
  cycleMadeProgress,
  stepCadence,
  stepStallAlert,
} from "./cycle-progress";
import { formatLogDetail } from "./log-detail";
import {
  RECOMPUTE_OUTCOME,
  type RecomputeOutcome,
  nextRecomputeDelayMs,
} from "./recompute-schedule";
import {
  SK_DOCUMENT_DRAIN_TIMING,
  runSkDocumentDrain,
} from "./sk-document-drain";
import {
  SOURCE_TOTAL_POLL_TIMING,
  runSourceTotalPoll,
} from "./source-total-poll";
import { isTransientConnectionError } from "./transient-connection-error";

const logInfo = (message: string): void => {
  void Bun.write(Bun.stdout, `${message}\n`);
};

const logError = (message: string, detail?: unknown): void => {
  const formattedDetail = formatLogDetail(detail);
  const line = formattedDetail ? `${message} ${formattedDetail}` : message;
  void Bun.write(Bun.stderr, `${line}\n`);
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
const drainController = new AbortController();

const drainOnSigterm = (): void => {
  process.on("SIGTERM", () => {
    if (isDraining()) {
      return;
    }
    draining = true;
    drainController.abort();
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
/** Base of the failure backoff, and the cadence a healthy adapter runs at. */
const CYCLE_DELAY_MS = CYCLE_CADENCE_DELAY_MS[CYCLE_CADENCE.FAST];
const HEALTH_INTERVAL_MS = 30_000;
const SUSTAINED_FAILURE_THRESHOLD = 5;
const SEARCH_INDEX_INTERVAL_MS = 10_000;
// The missing-row probe walks created_at order past every already-projected
// row, so a caught-up projection pays nearly a full scan just to find
// nothing. Back the poll off while it comes up empty; any hit resets to the
// base interval, so a fresh ingest batch is picked up promptly.
const SEARCH_INDEX_IDLE_MAX_MS = 15 * 60_000;
const SEARCH_INDEX_BATCH_SIZE = 20;
const SEARCH_INDEX_DRAIN_CONCURRENCY = 4;
// Throughput comes from the environment so a drain can be sped up or
// reverted as a deployment change; the defaults preserve the historical
// pace.
const CORPUS_INDEX_INTERVAL_MS = envBase.CORPUS_INDEX_INTERVAL_MS;
const CORPUS_INDEX_BATCH_SIZE = envBase.CORPUS_INDEX_BATCH_SIZE;
const CORPUS_INDEX_READ_CONCURRENCY = envBase.CORPUS_INDEX_READ_CONCURRENCY;
// Deferred Slovak documents. The page size is how many rows one tier query
// reads ahead of the walk, and the probe interval is the longest a decision
// a reader asked for waits behind the bulk tier. Neither touches throughput:
// that is the fetch gap and nothing else.
const SK_DOCUMENT_PAGE_SIZE = 20;
const SK_DOCUMENT_REQUESTED_POLL_INTERVAL_MS = 5000;
// Citation authority decays slowly; a periodic full recompute keeps the
// materialized ranking signal fresh without per-cycle cost. The first
// recompute runs shortly after startup rather than a full interval in: a
// process whose lifetime is shorter than the interval would otherwise
// never recompute at all. The startup delay keeps a process that exits
// quickly after boot from adding a whole-corpus recompute to every start.
const CITATION_AUTHORITY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CITATION_AUTHORITY_STARTUP_DELAY_MS = 5 * 60 * 1000;
// Decisions per statement, and the gap between two statements. Together they
// are the sweep's throughput and the share of the database it takes: at the
// defaults a sweep covers a few million decisions in well under the refresh
// interval while leaving the ingest loops and readers the rest of the time.
// Env-configurable (CITATION_AUTHORITY_BATCH_SIZE / _BATCH_DELAY_MS) like the
// citation-resolution walk, so the sweep can be slowed without a build.
const CITATION_AUTHORITY_BATCH_SIZE =
  LEGAL_ATLAS_RUNNER_ENV.citationAuthorityBatchSize;
const CITATION_AUTHORITY_BATCH_DELAY_MS =
  LEGAL_ATLAS_RUNNER_ENV.citationAuthorityBatchDelayMs;
// Poll gap once the corpus is current, and the ceiling any failure backoff
// settles at. Short relative to the refresh interval, so the first decisions
// to fall due are picked up promptly rather than at the next interval mark.
const CITATION_AUTHORITY_IDLE_DELAY_MS = 10 * 60 * 1000;

// Cadence backoff (thresholds, delays and the state machine live in
// ./cycle-progress): a caught-up adapter polls daily. One that keeps
// re-fetching decisions it already holds polls hourly because that signal can
// also describe a legitimate forward re-ingest. Either resets to the fast
// cadence on the next cycle that writes a row. This keeps us from hammering
// court servers in steady state without stalling a catch-up walk for months.

/** Log line for entering a cadence, so a transition is greppable. */
const CADENCE_ENTRY_MESSAGE = {
  [CYCLE_CADENCE.FAST]: "Resuming fast cadence",
  [CYCLE_CADENCE.CAUGHT_UP]: "Caught up; switching to daily polling",
  [CYCLE_CADENCE.UNPRODUCTIVE_BACKOFF]:
    "Re-fetching stored decisions without writing any; switching to hourly polling",
} as const satisfies Record<CycleCadence, string>;

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
// Summed from the engine's own phase bounds rather than restated, so this can
// never drift underneath what a healthy unit does — which is the whole failure
// this backstop had: a merely-large walk read as a wedge and took the process
// down with it. Listing dominates, and cannot be given a clock of its own (it
// has nowhere to resume from), so the deadline clears its worst case instead.
// Large, and correctly so: a backstop that fires before healthy work finishes
// is not a safety net, it is the fault.
const RECONCILIATION_HARD_DEADLINE_MS =
  RECONCILIATION_LISTING_WORST_CASE_MS +
  RECONCILIATION_INGEST_BUDGET_MS +
  RECONCILIATION_UNIT_SETTLE_MS;

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
 * Pages walked by any adapter since this process started.
 *
 * Counts `pagesProcessed`, not `inserted`, for the reason `cycleMadeProgress`
 * documents: a page parked on a persistent corpus-write failure breaks out
 * before the page counter increments, but reports rows written on every retry.
 * Counting inserts would make this rise fastest in exactly the stall it exists
 * to expose.
 *
 * It counts pages walked, not distance travelled: the pipeline increments
 * before its stagnation check, and a caught-up adapter that re-returns its
 * current cursor (cz-nss yields `${today}:0` once it reaches today) walks one
 * page per poll without the persisted cursor moving. That is deliberate here.
 * Being caught up is healthy — `cycleMadeProgress` treats a completed cycle as
 * progress even with nothing to show for it — so this is an activity counter
 * to read beside uptime, not a measure of new ground covered. Do not build a
 * stall alarm on it without first distinguishing the two.
 */
let pagesSinceStart = 0;

/**
 * Record that the daemon is running, and how far it has got.
 *
 * The file heartbeat above is overwritten in place, so it carries only the
 * latest timestamp and no history. This line is the durable counterpart.
 *
 * Written through `logInfo` rather than the OTel logger: that pipeline
 * deliberately configures no external exporter and mirrors only ERROR records
 * to stderr, so an INFO record there reaches nothing. A liveness signal that
 * is silently discarded is worse than none, because the absence looks
 * identical to a dead daemon.
 *
 * It belongs to the health loop rather than to any single unit of work: a
 * line emitted by a periodic job only appears if the process outlives that
 * job's period, so tying the record to the shortest loop keeps it independent
 * of how long any individual piece of work takes.
 *
 * Uptime comes from `process.uptime()`, not a wall-clock difference: an NTP
 * correction would make a `Date.now()` delta jump or run backwards, and this
 * value exists to be read when diagnosing restarts, which is exactly when a
 * fabricated lifetime would mislead. It also measures from process start
 * rather than from any point this module chooses.
 */
const logHeartbeat = (): void => {
  logInfo(
    `[health] case_law.ingestion.heartbeat ` +
      `uptimeSec=${Math.round(process.uptime())} ` +
      `pagesSinceStart=${pagesSinceStart} ` +
      `activeCycles=${inFlightCycles.size}`,
  );
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
    adapterKey: ADAPTER_KEYS.AT_COURTS,
    name: "Austrian Courts (RIS Justiz)",
  },
  {
    adapterKey: ADAPTER_KEYS.AT_VFGH,
    name: "Austrian Constitutional Court (RIS VfGH)",
  },
  {
    adapterKey: ADAPTER_KEYS.AT_VWGH,
    name: "Austrian Administrative Court (RIS VwGH)",
  },
  {
    adapterKey: ADAPTER_KEYS.AT_BVWG,
    name: "Austrian Federal Administrative Court (RIS BVwG)",
  },
  {
    adapterKey: ADAPTER_KEYS.AT_LVWG,
    name: "Austrian State Administrative Courts (RIS LVwG)",
  },
  {
    adapterKey: ADAPTER_KEYS.AT_ASYLGH,
    name: "Austrian Asylum Court (RIS AsylGH)",
  },
  {
    adapterKey: ADAPTER_KEYS.AT_UBAS,
    name: "Austrian Federal Asylum Senate (RIS UBAS)",
  },
  {
    adapterKey: ADAPTER_KEYS.AT_UVS,
    name: "Austrian Independent Administrative Senates (RIS UVS)",
  },
  {
    adapterKey: ADAPTER_KEYS.AT_VERG,
    name: "Austrian Procurement Review Bodies (RIS Verg)",
  },
  {
    adapterKey: ADAPTER_KEYS.AT_UMSE,
    name: "Austrian Environmental Senate (RIS Umweltsenat)",
  },
  {
    adapterKey: ADAPTER_KEYS.AT_BKS,
    name: "Austrian Federal Communications Senate (RIS BKS)",
  },
  {
    adapterKey: ADAPTER_KEYS.AT_FINDOK,
    name: "Austrian Fiscal Courts (Findok BFG and UFS)",
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
  const d = new Date(Date.now() - n * DAY_IN_MS);
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

type CycleAttempt =
  | { type: "drained" }
  | { type: "lease_busy" }
  | { cycle: CycleResult; type: "ran" };

const runOneCycle = async (
  adapterKey: string,
  name: string,
  bounds: CycleBounds = {},
): Promise<CycleAttempt> => {
  const initialCursor =
    adapterKey === ADAPTER_KEYS.CZ_REGIONAL ? daysAgoCursor(7) : null;

  const configuredSource = await ensureSource(adapterKey, name, initialCursor);
  const sourceLease = await acquireCaseLawSourceIngestionLease({
    scopedDb: ingestionDb,
    sourceId: configuredSource.id,
  });
  if (!sourceLease) {
    logInfo(`[${adapterKey}] Source is leased by another ingestion worker`);
    return {
      type: "lease_busy",
    };
  }
  const { source } = sourceLease;
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
    const signal = AbortSignal.any([
      AbortSignal.timeout(cycleMs),
      drainController.signal,
    ]);

    result = await runIngestionPipeline({
      source,
      sourceLease,
      scopedDb: ingestionDb,
      dbSlot: dbWriteSemaphore,
      signal,
      ...(bounds.maxPages !== undefined && { maxPages: bounds.maxPages }),
      ...(bounds.maxDecisions !== undefined && {
        maxDecisions: bounds.maxDecisions,
      }),
    });
    // Before the halt-reason handling and the ingestion-event write below:
    // pages already completed are durable regardless of how this cycle ends,
    // and a stalled event write must not hide them from the heartbeat.
    pagesSinceStart += result.pagesProcessed;
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
  } finally {
    try {
      await sourceLease.release();
    } catch (error) {
      logError(`[${adapterKey}] Failed to release source lease:`, error);
    }
  }

  if (drainController.signal.aborted) {
    return { type: "drained" };
  }

  const durationMs = Math.round(performance.now() - t0);
  const cursorAfter = result !== null ? result.nextCursor : cursorBefore;

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
        cursorAfter,
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
    cycle: {
      outcome,
      inserted: result?.inserted ?? 0,
      skipped: result?.skipped ?? 0,
      pagesProcessed: result?.pagesProcessed ?? 0,
      cursorAdvanced: cursorAfter !== cursorBefore,
    },
    type: "ran",
  };
};

/**
 * Independent loop for a single adapter. Runs forever,
 * catching all errors so it never crashes.
 */

const runAdapterLoop = async ({ adapterKey, name }: SourceDef) => {
  /** Stall streak plus the once-per-episode capture latch; see cycle-progress. */
  let stallAlert: StallAlertState = INITIAL_STALL_ALERT;
  /** Separate counter for backoff; not reset by the alert threshold. */
  let backoffFailures = 0;
  /** Quiet and unproductive streaks; drive the inter-cycle delay. */
  let streaks: CadenceStreaks = INITIAL_CADENCE_STREAKS;
  let cadence: CycleCadence = CYCLE_CADENCE.FAST;

  while (true) {
    if (isDraining()) {
      return;
    }
    let leaseBusy = false;
    /** Null when the cycle never ran (lease busy), so it folds no evidence. */
    let progressVerdict: boolean | null = null;
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
      let attempt: CycleAttempt;
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
        attempt = await runWithHardDeadline(
          adapterKey,
          CYCLE_HARD_DEADLINE_MS,
          async () => await runOneCycle(adapterKey, name),
        );
      } finally {
        inFlightCycles.delete(adapterKey);
        cycleSemaphore.release();
      }
      if (attempt.type === "lease_busy") {
        // Another healthy task owns this source during a rolling handoff.
        // This is neither source progress nor a failure; retry promptly without
        // mutating the source's accumulated health or cadence evidence.
        leaseBusy = true;
      } else if (attempt.type === "drained") {
        return;
      } else {
        const { cycle } = attempt;
        const { outcome } = cycle;

        // A stall is a cycle that advanced no page, whatever its outcome; a halt
        // or a timeout that still walked pages moved the cursor.
        const madeProgress = cycleMadeProgress(cycle);
        progressVerdict = madeProgress;

        if (outcome === CYCLE_OUTCOME.FAILED && !madeProgress) {
          backoffFailures++;
        } else {
          backoffFailures = 0;
          // How the cycle ended does not decide the cadence; what it wrote
          // does. An adapter whose page budget outlasts its cycle deadline
          // times out every cycle, so keying the cadence on a clean outcome
          // pinned a source re-fetching its stored corpus to the fast cadence
          // forever, holding a cycle slot against sources with work.
          const step = stepCadence(streaks, cycle);
          streaks = step.streaks;
          if (step.cadence !== cadence) {
            cadence = step.cadence;
            logInfo(`[${adapterKey}] ${CADENCE_ENTRY_MESSAGE[cadence]}`);
          }
          if (step.unproductiveRescan) {
            logger.error("case_law.ingestion.unproductive_rescan", {
              adapterKey,
              ...step.unproductiveRescan,
            });
          }
        }
      }
    } catch (error) {
      // A thrown cycle made no forward progress either.
      progressVerdict = false;
      backoffFailures++;
      const msg = error instanceof Error ? error.message : String(error);
      if (isTransientConnectionError(error)) {
        logError(`[${adapterKey}] DB connection error (will retry): ${msg}`);
      } else {
        logError(`[${adapterKey}] Unexpected error:`, error);
      }
    }

    // A run of cycles that advanced no page means the source is stalled.
    // The log signal re-fires every threshold-worth of stalled cycles; the
    // exception capture fires once per episode, when it begins, so a source
    // outage reaches error tracking as one alert instead of one event per
    // failed fetch.
    if (progressVerdict !== null) {
      const stall = stepStallAlert(
        stallAlert,
        progressVerdict,
        SUSTAINED_FAILURE_THRESHOLD,
      );
      stallAlert = stall.state;
      if (stall.sustained !== null) {
        logger.error("case_law.ingestion.sustained_failure", {
          adapterKey,
          noProgressStreak: stall.sustained,
        });
        if (stall.capture) {
          captureError(
            new IngestionStallError({
              message: `Source made no progress for ${stall.sustained} consecutive cycles`,
              adapterKey,
              code: adapterKey,
              noProgressCycles: stall.sustained,
            }),
            { adapterKey },
          );
        }
      }
    }

    writeHeartbeat();
    // Failure backoff wins when active (5s, 10s, 20s, 40s, cap 60s).
    // Otherwise the cadence the last returned cycle earned.
    let delayMs = CYCLE_CADENCE_DELAY_MS[cadence];
    if (leaseBusy) {
      delayMs = CYCLE_DELAY_MS;
    } else if (backoffFailures > 0) {
      delayMs = Math.min(CYCLE_DELAY_MS * 2 ** backoffFailures, 60_000);
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

  drainOnSigterm();

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
    if (isDraining()) {
      return 0;
    }
    const attempt = await runOneCycle(match.adapterKey, match.name, {
      maxPages,
      maxDecisions,
    });
    if (attempt.type === "lease_busy" || attempt.type === "drained") {
      return 0;
    }
    return attempt.cycle.outcome === CYCLE_OUTCOME.COMPLETED ? 0 : 1;
  }

  if (SOURCES.length === 0) {
    logError("No adapters enabled. Check DISABLED_ADAPTERS env var.");
    return 1;
  }

  // All adapters: independent concurrent loops.
  daemonMode = true;
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
      logHeartbeat();
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
    // Gated on storage, not on the legal-search provider: global search
    // reads case_law_search_documents directly whatever LEGAL_SEARCH_PROVIDER
    // is set to, so this projection has consumers under every provider. What
    // ends it is canonical storage, where a new row carries no Postgres text
    // to project. Rows created meanwhile stay pending, and the backfill
    // catches them up if the mode is ever rolled back.
    if (corpusStorageMode === "canonical") {
      return;
    }
    let pollMs = SEARCH_INDEX_INTERVAL_MS;
    while (true) {
      if (isDraining()) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- fixed-interval backfill poll; the loop must wait between batches, so this await is intentionally sequential
      await Bun.sleep(pollMs);
      if (isDraining()) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one bounded backfill batch per interval; the next poll only runs after this batch completes
        const { found, indexed } = await runWithHardDeadline(
          "search-index",
          SEARCH_INDEX_HARD_DEADLINE_MS,
          async () =>
            await backfillSearchIndex(backfillDb, SEARCH_INDEX_BATCH_SIZE),
        );
        // Back off only when the probe found nothing: a batch that was
        // found but failed to index is pending work and keeps the base
        // retry cadence.
        pollMs =
          found === 0
            ? Math.min(pollMs * 2, SEARCH_INDEX_IDLE_MAX_MS)
            : SEARCH_INDEX_INTERVAL_MS;
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

  // Citation-authority refresh loop: keeps the materialized ranking signal
  // current, in bounded batches. The whole-corpus form was one UPDATE over
  // every decision, which on this corpus outruns its statement timeout and
  // rolls back — spending the work and keeping none of it, every time. A batch
  // is bounded by its row count, and `citation_authority_computed_at` is the
  // only bookkeeping: recomputing a decision stamps it and takes it out of the
  // set, so a replaced task resumes without anything having been persisted
  // about where it was.
  //
  // Runs via the ingestion role outside the DB slot. The try-lock is per batch
  // rather than per sweep, so a rolling deployment costs one batch's
  // contention instead of a sweep's worth of progress.
  const citationAuthorityLoop = (async () => {
    await Bun.sleep(CITATION_AUTHORITY_STARTUP_DELAY_MS);
    let consecutiveFailures = 0;
    let recomputedSinceLog = 0;
    while (true) {
      if (isDraining()) {
        return;
      }
      let outcome: RecomputeOutcome = RECOMPUTE_OUTCOME.FAILED;
      try {
        // oxlint-disable-next-line no-await-in-loop -- O(1) partial-index probe once per batch
        const rankable = await ingestionDb(hasResolvedCitations);
        if (!rankable) {
          // A sweep would walk the corpus writing zeroes.
          outcome = RECOMPUTE_OUTCOME.IDLE;
          logInfo(
            "[citation-authority] Idle (no resolved citations to rank yet)",
          );
        } else {
          // oxlint-disable-next-line no-await-in-loop -- one bounded batch at a time; the next only starts once this one is durable
          const courtWeightEntries = await loadCourtWeightEntries();
          // A rolling window, not a pinned one: the sweep is continuous and
          // has no start, and a row recomputed an interval ago is due again
          // whatever this process was doing then. Expressed as an age so both
          // the boundary and the stamp come from PostgreSQL — a host clock
          // running ahead of the database would otherwise leave every row it
          // just stamped still older than the boundary, and the walk would
          // rewrite the same oldest rows forever.
          // oxlint-disable-next-line no-await-in-loop -- one bounded batch at a time; the next only starts once this one is durable
          const batch = await runWithHardDeadline(
            "citation-authority",
            BACKFILL_HARD_DEADLINE_MS,
            async () =>
              await ingestionDb(
                async (tx) =>
                  await tryRecomputeCitationAuthorityBatch(tx, {
                    limit: CITATION_AUTHORITY_BATCH_SIZE,
                    window: {
                      type: "olderThan",
                      ms: CITATION_AUTHORITY_INTERVAL_MS,
                    },
                    courtWeightEntries,
                  }),
              ),
          );
          if (batch === null) {
            outcome = RECOMPUTE_OUTCOME.SKIPPED;
          } else if (batch.recomputed === 0) {
            outcome = RECOMPUTE_OUTCOME.CURRENT;
            if (recomputedSinceLog > 0) {
              logInfo(
                `[citation-authority] Sweep complete (${recomputedSinceLog} decisions recomputed)`,
              );
              recomputedSinceLog = 0;
            }
          } else {
            outcome = RECOMPUTE_OUTCOME.ADVANCED;
            recomputedSinceLog += batch.recomputed;
          }
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
      consecutiveFailures =
        outcome === RECOMPUTE_OUTCOME.FAILED ? consecutiveFailures + 1 : 0;
      // oxlint-disable-next-line no-await-in-loop -- batch pacing; the loop must wait between batches, so this await is intentionally sequential
      await Bun.sleep(
        nextRecomputeDelayMs({
          outcome,
          consecutiveFailures,
          batchDelayMs: CITATION_AUTHORITY_BATCH_DELAY_MS,
          idleDelayMs: CITATION_AUTHORITY_IDLE_DELAY_MS,
        }),
      );
    }
  })();

  // The standing citation-resolution walk: settles every citation the corpus
  // holds against the decisions it holds, continuously, because the answer
  // changes as the crawl proceeds. A decision arriving under a key nothing
  // matched makes unmatched citations resolvable; a second decision under a
  // key that had one holder retracts the edge drawn to the first. Both are put
  // back in the queue by the ingestion pipeline, so the queue never
  // permanently empties.
  //
  // Overlapping runner replicas during a rolling deployment take a
  // transaction-scoped advisory lock per batch, so the replacement finds the
  // walk held and asks again rather than duplicating its work.
  const citationResolutionLoop = (async () => {
    if (!LEGAL_ATLAS_RUNNER_ENV.caseLawCitationResolutionEnabled) {
      return;
    }
    const batchSize = LEGAL_ATLAS_RUNNER_ENV.citationResolutionBatchSize;
    const batchDelayMs = LEGAL_ATLAS_RUNNER_ENV.citationResolutionBatchDelayMs;
    logInfo(
      `[citation-resolution] Enabled (${batchSize} citations per ${batchDelayMs}ms)`,
    );
    await runCitationResolutionDrain({
      settleBatch: async (): Promise<CitationResolutionStep> => {
        const batch = await runWithHardDeadline(
          "citation-resolution",
          BACKFILL_HARD_DEADLINE_MS,
          async () =>
            await tryResolveCitationBatch(backfillDb, { limit: batchSize }),
        );
        if (batch === null) {
          return { type: CITATION_RESOLUTION_STEP.BUSY };
        }
        if (batch.scanned === 0) {
          return { type: CITATION_RESOLUTION_STEP.DRAINED };
        }
        return { type: CITATION_RESOLUTION_STEP.SETTLED, counts: batch };
      },
      // Bounded like the batch is. A rejection is safe — the loop catches it
      // and reports the window anyway — but a hang is not: the summary flush
      // is awaited inside the walk, so a gauge query that never returns parks
      // the whole thing. The database's statement timeout normally covers
      // this, and `DB_BACKFILL_TRANSACTION_TIMEOUT_MS=0` deliberately removes
      // that cover.
      readPending: async () =>
        await runWithHardDeadline(
          "citation-resolution-gauge",
          BACKFILL_HARD_DEADLINE_MS,
          async () => await countPendingCitations(backfillDb),
        ),
      errorTag,
      isDraining,
      now: Date.now,
      report: (summary) => {
        // Work waiting and nothing examined is the one outcome a log of
        // successes cannot express, so it leaves a structured record of its
        // own rather than a number inside the line below.
        if (summary.idleContradictionWindows !== null) {
          logger.error("case_law.citation_resolution.idle_contradiction", {
            pending: summary.pending ?? 0,
            windows: summary.idleContradictionWindows,
            lastErrorType: summary.lastErrorTag ?? "none",
          });
        }
        // A citing jurisdiction with no declared resolution policy is a
        // registry gap, not sweep noise: those citations are never examined,
        // and the fix is a declaration.
        if (summary.undeclaredJurisdiction > 0) {
          logger.error("case_law.citation_resolution.undeclared_jurisdiction", {
            citations: summary.undeclaredJurisdiction,
          });
        }
        logInfo(
          `[citation-resolution] case_law.citation_resolution.swept ` +
            `batches=${summary.batches} ` +
            `scanned=${summary.scanned} ` +
            `resolved=${summary.resolved} ` +
            `unmatched=${summary.unmatched} ` +
            `ambiguous=${summary.ambiguous} ` +
            `jurisdictionBlocked=${summary.jurisdictionBlocked} ` +
            `undeclaredJurisdiction=${summary.undeclaredJurisdiction} ` +
            `pending=${summary.pending ?? "unknown"} ` +
            `drained=${summary.drained} ` +
            `busy=${summary.busy} ` +
            `errored=${summary.errored} ` +
            `lastErrorType=${summary.lastErrorTag ?? "none"}`,
        );
      },
      sleep: async (ms) => {
        await Bun.sleep(ms);
      },
      timing: { ...CITATION_RESOLUTION_DRAIN_TIMING, batchDelayMs },
    });
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
    // Acceptance is not durability for the bulk pages of a rebuild, and no
    // per-request signal can prove a whole generation landed. Counting both
    // sides on this loop's own cadence is what makes a lost split visible
    // at all: the rows it lost are neither missing nor stale, so nothing
    // else in this process would ever look at them again.
    const census = createCaseLawCensus({ generation, scopedDb: backfillDb });
    const countSeed = createCaseLawCorpusIndexCountSeed({
      generation,
      scopedDb: backfillDb,
    });
    // A leaked lease (every step BUSY) and a failing backend (every step
    // throws) both look like idle silence in this loop unless counted.
    let corpusStreaks: CorpusIndexStreaks = INITIAL_CORPUS_INDEX_STREAKS;
    const stallThreshold = corpusIndexStallThreshold(CORPUS_INDEX_INTERVAL_MS);
    const foldCorpusStep = (kind: CorpusIndexStepKind): void => {
      const step = stepCorpusIndexProgress({
        kind,
        streaks: corpusStreaks,
        threshold: stallThreshold,
      });
      corpusStreaks = step.streaks;
      if (!step.stall) {
        return;
      }
      logger.error(
        step.stall.kind === "sustained_busy"
          ? "case_law.corpus_index.sustained_busy"
          : "case_law.corpus_index.sustained_failure",
        { generation, steps: step.stall.steps },
      );
    };
    while (true) {
      if (isDraining()) {
        return;
      }
      // The census rides the interval the loop is idle for anyway, so it
      // costs the backfill no latency and runs on every cycle — including
      // the ones where the batch failed or found nothing, which is
      // exactly when drift stops being repaired. It contains its own
      // failures, so it cannot turn a slow cycle into a stopped loop.
      // oxlint-disable-next-line no-await-in-loop -- fixed-interval backfill poll; the loop must wait CORPUS_INDEX_INTERVAL_MS between batches, so this await is intentionally sequential
      await Promise.all([
        Bun.sleep(CORPUS_INDEX_INTERVAL_MS),
        census.step(),
        runWithHardDeadline(
          "corpus-index-count-seed",
          BACKFILL_HARD_DEADLINE_MS,
          async () => await countSeed.step(),
        ),
      ]);
      if (isDraining()) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one bounded backfill batch per interval; the next poll only runs after this batch completes
        const result = await runWithHardDeadline(
          "corpus-index",
          BACKFILL_HARD_DEADLINE_MS,
          async () =>
            await backfillCorpusIndex(
              backfillDb,
              CORPUS_INDEX_BATCH_SIZE,
              generation,
              { readConcurrency: CORPUS_INDEX_READ_CONCURRENCY },
            ),
        );
        if (result.indexed > 0) {
          logInfo(`[corpus-index] Indexed ${result.indexed} decisions`);
        }
        switch (result.status) {
          case BACKFILL_STATUS.ADVANCED:
            foldCorpusStep(CORPUS_INDEX_STEP.ADVANCED);
            break;
          case BACKFILL_STATUS.BUSY:
            foldCorpusStep(CORPUS_INDEX_STEP.BUSY);
            break;
          case BACKFILL_STATUS.COMPLETE:
            foldCorpusStep(CORPUS_INDEX_STEP.COMPLETE);
            break;
          default: {
            const unhandled: never = result;
            panic(`Unhandled corpus index result: ${String(unhandled)}`);
          }
        }
      } catch (error) {
        foldCorpusStep(CORPUS_INDEX_STEP.FAILED);
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
    // Ungated, unlike its case-law sibling: legislation stays dual-write by
    // scope decision, so its rows always carry the text this projection
    // needs and it must always keep building.
    let pollMs = SEARCH_INDEX_INTERVAL_MS;
    while (true) {
      if (isDraining()) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- fixed-interval backfill poll; the loop must wait between batches, so this await is intentionally sequential
      await Bun.sleep(pollMs);
      if (isDraining()) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one bounded backfill batch per interval; the next poll only runs after this batch completes
        const { found, indexed } = await runWithHardDeadline(
          "legislation-search-index",
          SEARCH_INDEX_HARD_DEADLINE_MS,
          async () =>
            await backfillLegislationSearchIndex(
              backfillDb,
              SEARCH_INDEX_BATCH_SIZE,
            ),
        );
        pollMs =
          found === 0
            ? Math.min(pollMs * 2, SEARCH_INDEX_IDLE_MAX_MS)
            : SEARCH_INDEX_INTERVAL_MS;
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

  // Deferred Slovak document walk: `sk-courts` ingests metadata only, so
  // every page it stores leaves decisions with nothing readable until this
  // fetches and parses their PDF. Continuous rather than scheduled, because
  // the fetch gap is already the constraint and an outer interval could only
  // hold it below that. Gated: it is the one loop here that fetches from a
  // publisher outside an adapter crawl.
  //
  // Overlapping runner replicas each pace their own clock, so the aggregate
  // fetch rate briefly multiplies during a rolling deployment. Accepted
  // rather than leased: the queue's per-document claims keep the work
  // correct and unduplicated, the service runs one task otherwise, and the
  // overlap is bounded by the deployment window.
  const skDocumentLoop = (async () => {
    if (!LEGAL_ATLAS_RUNNER_ENV.skDocumentBackfillEnabled) {
      return;
    }
    const fetchDelayMs = LEGAL_ATLAS_RUNNER_ENV.skDocumentFetchDelayMs;
    logInfo(`[sk-documents] Enabled (one fetch per ${fetchDelayMs}ms)`);
    await runSkDocumentDrain({
      queue: createPendingDocumentQueue({
        loaders: scopedPendingDocumentTierLoaders(backfillDb),
        pageSize: SK_DOCUMENT_PAGE_SIZE,
        requestedPollIntervalMs: SK_DOCUMENT_REQUESTED_POLL_INTERVAL_MS,
      }),
      // The unit bounds itself (download timeout, wall-clock budget) and
      // the transaction handle bounds its writes; the hard deadline is the
      // same backstop the other loops carry, for a future await that slips
      // in unbounded and would otherwise park the walk forever.
      fetchDocument: async (decision) =>
        await runWithHardDeadline(
          "sk-documents",
          BACKFILL_HARD_DEADLINE_MS,
          async () =>
            await fetchDecisionDocument({
              decision,
              scopedDb: backfillDb,
              signal: AbortSignal.timeout(DOCUMENT_FETCH_BUDGET_MS),
            }),
        ),
      isDraining,
      now: Date.now,
      report: (summary) => {
        logInfo(
          `[sk-documents] case_law.sk_documents.swept ` +
            `attempted=${summary.attempted} ` +
            `filled=${summary.filled} ` +
            `unavailable=${summary.unavailable} ` +
            `claimed=${summary.claimed} ` +
            `superseded=${summary.superseded} ` +
            `failed=${summary.failed} ` +
            `lastErrorType=${summary.failed === 0 ? "none" : errorTag(summary.lastError)}`,
        );
      },
      sleep: async (ms) => {
        await Bun.sleep(ms);
      },
      timing: { ...SK_DOCUMENT_DRAIN_TIMING, fetchDelayMs },
    });
  })();

  // The standing listing reconciliation: for every source whose adapter can
  // be asked what its publisher lists for a slice, keep verifying that what is
  // listed is held, ingest the misses, and park what repeatedly refuses so the
  // hunt reaches a fixed point instead of re-fetching the same unservable
  // document forever. On unless a deployment turns it off.
  //
  // Each unit takes the source's ingestion lease, so overlapping runner
  // replicas during a rolling deployment cannot interleave two writers on one
  // source; the replacement simply finds the source leased and asks again.
  const reconciliationLoop = (async () => {
    if (!LEGAL_ATLAS_RUNNER_ENV.caseLawReconciliationEnabled) {
      return;
    }
    const fetchDelayMs = LEGAL_ATLAS_RUNNER_ENV.reconciliationFetchDelayMs;
    const reconcilable: ReconciliationSource[] = [];
    for (const { adapterKey, name } of SOURCES) {
      const reconciliation = getAdapter(adapterKey)?.reconciliation;
      // Every case-law adapter implements the capability. Absence here means
      // the configured source key has no registered adapter.
      if (reconciliation === undefined) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one bounded source lookup per configured source, at startup
      const source = await ensureSource(adapterKey, name, null);
      // One schedule per source, living as long as this process: a slice whose
      // walk threw is held out of that source's selection order until its
      // retry comes due, so it cannot be handed back on every turn.
      const sliceRetries: SliceRetrySchedule = new Map();
      reconcilable.push({
        adapterKey,
        runWorkUnit: async () => {
          const outcome = await runWithHardDeadline(
            "case-law-reconciliation",
            RECONCILIATION_HARD_DEADLINE_MS,
            async () =>
              await runReconciliationWorkUnit({
                adapterKey,
                sourceId: source.id,
                reconciliation,
                scopedDb: backfillDb,
                now: () => new Date(),
                fetchDelayMs,
                sleep: async (ms) => {
                  await Bun.sleep(ms);
                },
                sliceRetries,
              }),
          );
          switch (outcome.type) {
            case "worked":
              return {
                turn: RECONCILIATION_TURN.WORKED,
                counts: outcome.summary,
              };
            case "leased":
              return { turn: RECONCILIATION_TURN.LEASED };
            case "idle":
              return { turn: RECONCILIATION_TURN.IDLE };
            default: {
              const exhaustive: never = outcome;
              return panic(
                `Unhandled reconciliation outcome: ${JSON.stringify(exhaustive)}`,
              );
            }
          }
        },
      });
    }
    if (reconcilable.length === 0) {
      return;
    }
    logInfo(
      `[reconciliation] Enabled for ${reconcilable
        .map(({ adapterKey }) => adapterKey)
        .join(", ")} (one fetch per ${fetchDelayMs}ms)`,
    );
    await runCaseLawReconciliationLoop({
      sources: reconcilable,
      isDraining,
      now: Date.now,
      report: (summary) => {
        logInfo(
          `[reconciliation] case_law.reconciliation.swept ` +
            `worked=${summary.worked} ` +
            `idle=${summary.idle} ` +
            `leased=${summary.leased} ` +
            `listed=${summary.listed} ` +
            `keyable=${summary.keyable} ` +
            `unidentifiable=${summary.unidentifiable} ` +
            `held=${summary.heldBefore} ` +
            `scheduled=${summary.scheduled} ` +
            `written=${summary.written} ` +
            `parked=${summary.parked} ` +
            `terminal=${summary.terminal} ` +
            `resolved=${summary.resolved} ` +
            `deferred=${summary.deferred} ` +
            `pruned=${summary.pruned} ` +
            `failed=${summary.failed} ` +
            `errored=${summary.errored} ` +
            `erroredSources=${summary.erroredSources.join(",") || "none"} ` +
            `lastErrorType=${summary.errored === 0 ? "none" : errorTag(summary.lastError)}`,
        );
      },
      sleep: async (ms) => {
        await Bun.sleep(ms);
      },
      timing: { ...RECONCILIATION_LOOP_TIMING, unitDelayMs: fetchDelayMs },
    });
  })();

  // Publisher-reported totals: the denominator held-vs-total coverage is
  // measured against. Only some publishers expose a count; those adapters
  // are asked here, and the rest keep the figure an operator recorded. The
  // cadence is when a source was last recorded or asked, not this loop's
  // interval, so a deployment neither loses a cycle nor re-asks every
  // publisher on boot.
  const sourceTotalLoop = (async () => {
    // The enabled set, not the registry: a poll is an external request like
    // any other, so it must not reach a publisher an operator disabled, nor
    // the adapter ALL_SOURCES holds back as not production-validated.
    const pollableAdapters = SOURCES.flatMap(({ adapterKey }) => {
      const adapter = getAdapter(adapterKey);
      if (adapter === undefined) {
        logError(
          `[source-totals] No adapter registered for source ${adapterKey}`,
        );
        return [];
      }
      return [adapter];
    });

    await runSourceTotalPoll({
      adapters: pollableAdapters,
      isDraining,
      now: Date.now,
      readTotals: async () => await readSourceReportedTotals(ingestionDb),
      recordTotal: async ({ adapterKey, asOf, total }) =>
        await setSourceReportedTotal({
          scopedDb: ingestionDb,
          adapterKey,
          total,
          asOf,
          origin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
        }),
      report: (summary) => {
        // An adapter the sources table does not carry is registry drift: a
        // number was read from a publisher and then had nowhere to go. That
        // is a defect, not sweep noise, so it leaves a structured record of
        // its own rather than a count inside the line below.
        if (summary.unknownSource > 0) {
          logger.error("case_law.source_totals.unknown_source", {
            "caseLawSourceTotals.unknownSource": summary.unknownSource,
          });
        }
        logInfo(
          `[source-totals] case_law.source_totals.polled ` +
            `polled=${summary.polled} ` +
            `recorded=${summary.recorded} ` +
            `noCount=${summary.noCount} ` +
            `failed=${summary.failed} ` +
            `unknownSource=${summary.unknownSource} ` +
            `lastErrorType=${summary.lastErrorTag ?? "none"}`,
        );
      },
      sleep: async (ms) => {
        await Bun.sleep(ms);
      },
      timing: SOURCE_TOTAL_POLL_TIMING,
    });
  })();

  await Promise.all([
    ...adapterLoops,
    healthLoop,
    searchIndexLoop,
    citationResolutionLoop,
    citationAuthorityLoop,
    corpusIndexLoop,
    legislationSearchIndexLoop,
    legislationCorpusIndexLoop,
    skDocumentLoop,
    reconciliationLoop,
    sourceTotalLoop,
  ]);
  return 0;
};
