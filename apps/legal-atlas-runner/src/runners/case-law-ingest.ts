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

import { createIngestionDb } from "@/api/db";
import { rootDb, rlsDb } from "@/api/db/root";
import { caseLawIngestionEvents, caseLawSources } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { recomputeCitationAuthorityForAll } from "@/api/handlers/case-law/citation-authority";
import { ADAPTER_KEYS, MAX_CYCLE_MS } from "@/api/handlers/case-law/consts";
import { backfillCorpusIndex } from "@/api/handlers/case-law/corpus-index";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters";
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import { backfillSearchIndex } from "@/api/handlers/case-law/search-index";
import { backfillLegislationCorpusIndex } from "@/api/handlers/legislation/corpus-index";
import { backfillLegislationSearchIndex } from "@/api/handlers/legislation/search-index";
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

import { LEGAL_ATLAS_RUNNER_ENV } from "../env";

const formatLogDetail = (detail: unknown): string => {
  if (detail === undefined) {
    return "";
  }

  if (detail instanceof Error) {
    return detail.stack ?? detail.message;
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

// Case-law ingestion writes the global corpus. The customer-scoped
// `stella` role is read-only on case_law_* (see migration
// 20260510140000); the daemon switches to `stella_ingestion`, which
// has narrow writes on the corpus and nothing else. Any future code
// path that strays outside case_law_* will hit a loud
// `permission denied`.
const ingestionDb = createIngestionDb(rlsDb);

/**
 * Bun's native Postgres pool emits unhandled errors when the
 * server closes a connection (e.g. database failover or
 * network interruption). The internal `#onClose` callback
 * throws a PostgresError that isn't caught by query-level
 * try/catch. Without this handler, the process crashes on
 * any connection drop.
 *
 * Adapter loops already retry on the next cycle, so the
 * daemon self-heals within CYCLE_DELAY_MS (5s).
 */
const isTransientConnectionError = (msg: string): boolean =>
  msg.includes("Connection closed") ||
  msg.includes("ERR_POSTGRES_CONNECTION_CLOSED") ||
  msg.includes("PostgresError");

/** Set to true once daemon mode starts; single-adapter mode exits on all errors. */
let daemonMode = false;

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (daemonMode && isTransientConnectionError(message)) {
    logError(`[daemon] DB connection lost (will retry): ${message}`);
    return;
  }
  logError("[daemon] Unhandled rejection:", reason);
  process.exit(1);
});

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
const CORPUS_INDEX_INTERVAL_MS = 15_000;
// Citation authority decays slowly; a periodic full recompute keeps the
// materialized ranking signal fresh without per-cycle cost.
const CITATION_AUTHORITY_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Idle backoff: once an adapter is caught up (no new decisions
// for IDLE_THRESHOLD consecutive cycles), poll once a day instead
// of every CYCLE_DELAY_MS. Resets to fast cadence on the next
// non-zero insert. Keeps us from hammering court servers in
// steady state.
const IDLE_THRESHOLD = 3;
const IDLE_DELAY_MS = 24 * 60 * 60 * 1000;

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

let activeDbSlots = 0;
const dbSlotQueue: (() => void)[] = [];

const acquireDbSlot = async (signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) {
    throw new DOMException("DB slot acquisition aborted", "AbortError");
  }
  if (activeDbSlots < MAX_CONCURRENT_DB_WRITES) {
    activeDbSlots++;
    await Promise.resolve();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const entry = () => {
      signal?.removeEventListener("abort", onAbort);
      activeDbSlots++;
      resolve();
    };
    const onAbort = () => {
      const idx = dbSlotQueue.indexOf(entry);
      if (idx !== -1) {
        dbSlotQueue.splice(idx, 1);
      }
      reject(new DOMException("DB slot acquisition aborted", "AbortError"));
    };
    dbSlotQueue.push(entry);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const releaseDbSlot = (): void => {
  activeDbSlots--;
  const next = dbSlotQueue.shift();
  if (next) {
    next();
  }
};

const writeHeartbeat = () => {
  void Bun.write(HEARTBEAT_PATH, new Date().toISOString()).catch(() => {
    // Non-fatal; health check will notice staleness
  });
};

// Adapters to skip. Set DISABLED_ADAPTERS env var to a
// comma-separated list of adapter keys (e.g. "sk-courts,pl-courts").
const DISABLED_ADAPTER_KEYS = new Set(
  LEGAL_ATLAS_RUNNER_ENV.disabledAdapters
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
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
  const existing = await rootDb.query.caseLawSources.findFirst({
    where: { adapterKey },
  });

  if (existing) {
    return existing;
  }

  const [created] = await rootDb
    .insert(caseLawSources)
    .values({
      adapterKey,
      name,
      syncCursor: initialCursor,
      config: {},
    })
    .returning();

  // TODO: fix this
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

type CycleOutcome = "completed" | "failed" | "timeout";

type CycleResult = {
  outcome: CycleOutcome;
  inserted: number;
};

/**
 * Run a single ingestion cycle for one adapter.
 * "timeout" means the cycle hit MAX_CYCLE_MS but progress
 * was made (cursor advanced) — not a true failure.
 */
const runOneCycle = async (
  adapterKey: string,
  name: string,
): Promise<CycleResult> => {
  const initialCursor =
    adapterKey === ADAPTER_KEYS.CZ_REGIONAL ? daysAgoCursor(7) : null;

  const source = await ensureSource(adapterKey, name, initialCursor);
  const cursorBefore = source.syncCursor;

  logInfo(`[${adapterKey}] Ingesting (cursor: ${cursorBefore ?? "start"})`);

  const startedAt = new Date();
  const t0 = performance.now();

  let outcome: CycleOutcome = "completed";
  let errorMessage: string | null = null;
  let result: Awaited<ReturnType<typeof runIngestionPipeline>> | null = null;

  try {
    const adapter = getAdapter(adapterKey);
    const cycleMs = adapter?.maxCycleMs ?? MAX_CYCLE_MS;

    result = await runIngestionPipeline({
      source,
      scopedDb: ingestionDb,
      dbSlot: { acquire: acquireDbSlot, release: releaseDbSlot },
      signal: AbortSignal.timeout(cycleMs),
    });
    if (result.haltReason) {
      outcome =
        result.haltReason === "Cycle timeout exceeded" ? "timeout" : "failed";
      errorMessage = result.haltReason.slice(0, 2048);
    }
  } catch (error) {
    outcome = "failed";
    errorMessage =
      `[${errorTag(error)}] ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        2048,
      );
  }

  const durationMs = Math.round(performance.now() - t0);

  // DB status column only supports "completed" | "failed";
  // timeouts are recorded as "completed" (progress was made).
  const dbStatus = outcome === "failed" ? "failed" : "completed";

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

  if (outcome === "completed") {
    logInfo(
      `[${adapterKey}] Inserted: ${result?.inserted ?? 0}, ` +
        `Skipped: ${result?.skipped ?? 0}, ` +
        `Pages: ${result?.pagesProcessed ?? 0}, ` +
        `Duration: ${durationMs}ms`,
    );
  } else if (outcome === "timeout") {
    logInfo(
      `[${adapterKey}] Timed out after ${durationMs}ms ` +
        `(inserted: ${result?.inserted ?? 0}, pages: ${result?.pagesProcessed ?? 0})`,
    );
  } else {
    logError(`[${adapterKey}] Failed: ${errorMessage}`);
  }

  return { outcome, inserted: result?.inserted ?? 0 };
};

/**
 * Independent loop for a single adapter. Runs forever,
 * catching all errors so it never crashes.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- preserves the daemon's existing retry, alert, and idle-backoff state machine.
const runAdapterLoop = async ({ adapterKey, name }: SourceDef) => {
  let consecutiveFailures = 0;
  /** Separate counter for backoff; not reset by alert threshold. */
  let backoffFailures = 0;
  /** Consecutive completed cycles with zero inserts; drives idle backoff. */
  let idleCycles = 0;

  while (true) {
    try {
      const { outcome, inserted } = await runOneCycle(adapterKey, name);

      if (outcome === "failed") {
        consecutiveFailures++;
        backoffFailures++;
      } else {
        consecutiveFailures = 0;
        backoffFailures = 0;
        // Only "completed" outcomes count toward idle. A "timeout"
        // means the cycle hit MAX_CYCLE_MS mid-work; the adapter is
        // slow, not caught up, so leave idleCycles unchanged.
        if (outcome === "completed") {
          if (inserted > 0) {
            if (idleCycles >= IDLE_THRESHOLD) {
              logInfo(
                `[${adapterKey}] New decisions found; resuming fast cadence`,
              );
            }
            idleCycles = 0;
          } else {
            idleCycles++;
            if (idleCycles === IDLE_THRESHOLD) {
              logInfo(`[${adapterKey}] Caught up; switching to daily polling`);
            }
          }
        }
      }
    } catch (error) {
      consecutiveFailures++;
      backoffFailures++;
      const msg = error instanceof Error ? error.message : String(error);
      if (isTransientConnectionError(msg)) {
        logError(`[${adapterKey}] DB connection error (will retry): ${msg}`);
      } else {
        logError(`[${adapterKey}] Unexpected error:`, error);
      }
    }

    if (consecutiveFailures >= SUSTAINED_FAILURE_THRESHOLD) {
      logger.error("case_law.ingestion.sustained_failure", {
        adapterKey,
        consecutiveFailures,
      });
      // Reset alert counter to avoid flooding; backoffFailures
      // stays high so the delay doesn't collapse.
      consecutiveFailures = 0;
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
    await Bun.sleep(delayMs);
  }
};

export const runCaseLawIngest = async (
  argv: readonly string[],
): Promise<number> => {
  const filterKey = argv.at(0);

  // Single adapter: run once and exit (useful for debugging).
  if (filterKey) {
    const match = SOURCES.find((s) => s.adapterKey === filterKey);
    if (!match) {
      logError(
        `Unknown adapter: ${filterKey}. ` +
          `Valid keys: ${SOURCES.map((s) => s.adapterKey).join(", ")}`,
      );
      return 1;
    }
    await refreshS3();
    await refreshCorpusS3();
    const { outcome } = await runOneCycle(match.adapterKey, match.name);
    return outcome === "completed" ? 0 : 1;
  }

  if (SOURCES.length === 0) {
    logError("No adapters enabled. Check DISABLED_ADAPTERS env var.");
    return 1;
  }

  // All adapters: independent concurrent loops.
  daemonMode = true;
  logInfo("Ingestion daemon started.");
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
      await Bun.sleep(HEALTH_INTERVAL_MS);
      writeHeartbeat();
      try {
        if (isS3Stale()) {
          await refreshS3();
        }
        if (isCorpusS3Stale()) {
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
      await Bun.sleep(SEARCH_INDEX_INTERVAL_MS);
      try {
        const indexed = await backfillSearchIndex(
          ingestionDb,
          SEARCH_INDEX_BATCH_SIZE,
        );
        if (indexed > 0) {
          logInfo(`[search-index] Indexed ${indexed} decisions (backfill)`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isTransientConnectionError(msg)) {
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
  const citationAuthorityLoop = (async () => {
    while (true) {
      await Bun.sleep(CITATION_AUTHORITY_INTERVAL_MS);
      try {
        const updated = await ingestionDb(async (tx) => {
          const count = await recomputeCitationAuthorityForAll(tx);
          return count;
        });
        logInfo(`[citation-authority] Recomputed (${updated} cited decisions)`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isTransientConnectionError(msg)) {
          logError(
            `[citation-authority] DB connection error (will retry): ${msg}`,
          );
        } else {
          logError("[citation-authority] Recompute error:", error);
        }
      }
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
      await Bun.sleep(CORPUS_INDEX_INTERVAL_MS);
      try {
        const indexed = await backfillCorpusIndex(
          ingestionDb,
          LIMITS.corpusIndexBatchSize,
          generation,
        );
        if (indexed > 0) {
          logInfo(`[corpus-index] Indexed ${indexed} decisions`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isTransientConnectionError(msg)) {
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
      await Bun.sleep(SEARCH_INDEX_INTERVAL_MS);
      try {
        const indexed = await backfillLegislationSearchIndex(
          ingestionDb,
          SEARCH_INDEX_BATCH_SIZE,
        );
        if (indexed > 0) {
          logInfo(`[legislation-search-index] Indexed ${indexed} documents`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isTransientConnectionError(msg)) {
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
      await Bun.sleep(CORPUS_INDEX_INTERVAL_MS);
      try {
        const indexed = await backfillLegislationCorpusIndex(
          ingestionDb,
          LIMITS.corpusIndexBatchSize,
          generation,
        );
        if (indexed > 0) {
          logInfo(`[legislation-corpus-index] Indexed ${indexed} documents`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isTransientConnectionError(msg)) {
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
