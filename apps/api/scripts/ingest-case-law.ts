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
 *   bun apps/api/scripts/ingest-case-law.ts [adapter-key]
 *
 * Without arguments, runs all sources in independent loops.
 * With an adapter key, runs only that source once and exits.
 */

import { createScopedDb } from "@/api/db";
import { db } from "@/api/db/root";
import { caseLawIngestionEvents, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS, MAX_CYCLE_MS } from "@/api/handlers/case-law/consts";
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import { backfillSearchIndex } from "@/api/handlers/case-law/search-index";
import { toSafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { isS3Stale, refreshS3 } from "@/api/lib/s3";

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
    console.error(`[daemon] DB connection lost (will retry): ${message}`);
    return;
  }
  console.error("[daemon] Unhandled rejection:", reason);
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

/**
 * Max adapters doing DB-heavy work (insert + search index +
 * citation extraction) simultaneously. The pipeline acquires
 * a slot before processing decisions and releases it before
 * the next external API fetch, so court API I/O runs freely
 * in parallel while DB pressure is capped.
 */
const MAX_CONCURRENT_DB_WRITES = Math.max(
  1,
  Number.parseInt(process.env.MAX_CONCURRENT_DB_WRITES ?? "2", 10) || 2,
);

let activeDbSlots = 0;
const dbSlotQueue: (() => void)[] = [];

// eslint-disable-next-line require-await -- returns Promise on queued path
const acquireDbSlot = async (signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) {
    throw new DOMException("DB slot acquisition aborted", "AbortError");
  }
  if (activeDbSlots < MAX_CONCURRENT_DB_WRITES) {
    activeDbSlots++;
    return;
  }
  return new Promise<void>((resolve, reject) => {
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
  (process.env.DISABLED_ADAPTERS ?? "")
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
  console.log(`Disabled adapters: ${[...DISABLED_ADAPTER_KEYS].join(", ")}`);
}

const ensureSource = async (
  adapterKey: string,
  name: string,
  initialCursor: string | null,
) => {
  const existing = await db.query.caseLawSources.findFirst({
    where: { adapterKey },
  });

  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(caseLawSources)
    .values({
      adapterKey,
      name,
      syncCursor: initialCursor,
      config: {},
    })
    .returning();

  // TODO: fix this
  // oxlint-disable-next-line typescript/strict-boolean-expressions
  if (!created) {
    throw new Error(`Failed to create source row for adapter "${adapterKey}"`);
  }

  return created;
};

const daysAgoCursor = (n: number): string => {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const date = d.toISOString().split("T")[0];
  if (!date) {
    throw new Error("Invalid date format");
  }
  return date;
};

const scriptUserId = toSafeId<"user">("script_case_law");

type CycleOutcome = "completed" | "failed" | "timeout";

/**
 * Run a single ingestion cycle for one adapter.
 * "timeout" means the cycle hit MAX_CYCLE_MS but progress
 * was made (cursor advanced) — not a true failure.
 */
const runOneCycle = async (
  adapterKey: string,
  name: string,
): Promise<CycleOutcome> => {
  const initialCursor =
    adapterKey === ADAPTER_KEYS.CZ_REGIONAL ? daysAgoCursor(7) : null;

  const source = await ensureSource(adapterKey, name, initialCursor);
  const cursorBefore = source.syncCursor;

  console.log(`[${adapterKey}] Ingesting (cursor: ${cursorBefore ?? "start"})`);

  const startedAt = new Date();
  const t0 = performance.now();

  const scopedDb = createScopedDb(
    db,
    [],
    toSafeId<"organization">(""),
    scriptUserId,
  );

  let outcome: CycleOutcome = "completed";
  let errorMessage: string | null = null;
  let result: Awaited<ReturnType<typeof runIngestionPipeline>> | null = null;

  try {
    result = await runIngestionPipeline({
      source,
      scopedDb,
      dbSlot: { acquire: acquireDbSlot, release: releaseDbSlot },
      signal: AbortSignal.timeout(MAX_CYCLE_MS),
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
    await db.insert(caseLawIngestionEvents).values({
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
  } catch (eventError) {
    console.error(
      `[${adapterKey}] Failed to write ingestion event:`,
      eventError,
    );
  }

  if (outcome === "completed") {
    console.log(
      `[${adapterKey}] Inserted: ${result?.inserted ?? 0}, ` +
        `Skipped: ${result?.skipped ?? 0}, ` +
        `Pages: ${result?.pagesProcessed ?? 0}, ` +
        `Duration: ${durationMs}ms`,
    );
  } else if (outcome === "timeout") {
    console.log(
      `[${adapterKey}] Timed out after ${durationMs}ms ` +
        `(inserted: ${result?.inserted ?? 0}, pages: ${result?.pagesProcessed ?? 0})`,
    );
  } else {
    console.error(`[${adapterKey}] Failed: ${errorMessage}`);
  }

  return outcome;
};

/**
 * Independent loop for a single adapter. Runs forever,
 * catching all errors so it never crashes.
 */
const runAdapterLoop = async ({ adapterKey, name }: SourceDef) => {
  let consecutiveFailures = 0;
  /** Separate counter for backoff; not reset by alert threshold. */
  let backoffFailures = 0;

  while (true) {
    try {
      const status = await runOneCycle(adapterKey, name);

      if (status === "failed") {
        consecutiveFailures++;
        backoffFailures++;
      } else {
        consecutiveFailures = 0;
        backoffFailures = 0;
      }
    } catch (error) {
      consecutiveFailures++;
      backoffFailures++;
      const msg = error instanceof Error ? error.message : String(error);
      if (isTransientConnectionError(msg)) {
        console.error(
          `[${adapterKey}] DB connection error (will retry): ${msg}`,
        );
      } else {
        console.error(`[${adapterKey}] Unexpected error:`, error);
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
    // Exponential backoff: 5s, 10s, 20s, 40s, capped at 60s.
    // Uses a separate counter from alert threshold so the
    // delay doesn't reset every 5 failures.
    const delayMs =
      backoffFailures > 0
        ? Math.min(CYCLE_DELAY_MS * 2 ** backoffFailures, 60_000)
        : CYCLE_DELAY_MS;
    await Bun.sleep(delayMs);
  }
};

// ── Entry point ─────────────────────────────────────────

const filterKey = process.argv[2];

// Single adapter: run once and exit (useful for debugging).
if (filterKey) {
  const match = SOURCES.find((s) => s.adapterKey === filterKey);
  if (!match) {
    console.error(
      `Unknown adapter: ${filterKey}. ` +
        `Valid keys: ${SOURCES.map((s) => s.adapterKey).join(", ")}`,
    );
    process.exit(1);
  }
  await refreshS3();
  const status = await runOneCycle(match.adapterKey, match.name);
  process.exit(status === "completed" ? 0 : 1);
}

if (SOURCES.length === 0) {
  console.error("No adapters enabled. Check DISABLED_ADAPTERS env var.");
  process.exit(1);
}

// All adapters: independent concurrent loops.
daemonMode = true;
console.log("Ingestion daemon started.");
await refreshS3();
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
    } catch (error) {
      console.error("S3 credential refresh failed:", error);
    }
  }
})();

// Search index backfill loop: indexes decisions that were
// inserted without a tsvector (the pipeline no longer computes
// tsvectors inline). Runs at low priority outside the DB slot
// semaphore with bounded concurrency and a generous statement
// timeout so long texts don't block other work.
const searchIndexLoop = (async () => {
  const scopedDb = createScopedDb(
    db,
    [],
    toSafeId<"organization">(""),
    scriptUserId,
  );

  while (true) {
    await Bun.sleep(SEARCH_INDEX_INTERVAL_MS);
    try {
      const indexed = await backfillSearchIndex(
        scopedDb,
        SEARCH_INDEX_BATCH_SIZE,
      );
      if (indexed > 0) {
        console.log(`[search-index] Indexed ${indexed} decisions (backfill)`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (isTransientConnectionError(msg)) {
        console.error(
          `[search-index] DB connection error (will retry): ${msg}`,
        );
      } else {
        console.error("[search-index] Backfill error:", error);
      }
    }
  }
})();

await Promise.all([...adapterLoops, healthLoop, searchIndexLoop]);
