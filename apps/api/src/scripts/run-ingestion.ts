/**
 * Standalone case law ingestion runner.
 *
 * Loops through all enabled adapters, runs one pipeline cycle
 * per adapter, and repeats. Uses a PID lockfile to prevent
 * duplicate processes.
 *
 * Features:
 * - Single-instance lock via /tmp/ingestion.lock
 * - Auto-cursor recovery when syncCursor is null (derives
 *   approximate resume position from existing decisions)
 * - Persists cursors after each adapter cycle
 *
 * Usage:
 *   bun apps/api/src/scripts/run-ingestion.ts
 *
 * Or via systemd:
 *   ExecStart=/usr/bin/docker exec <container> \
 *     bun /app/apps/api/src/scripts/run-ingestion.ts
 */

import { count, eq, sql } from "drizzle-orm";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { db } from "@/api/db";
import type { ScopedDb } from "@/api/db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";

// ── Single-instance lock ────────────────────────────────

const LOCK_FILE = "/tmp/ingestion.lock";

const acquireLock = (): boolean => {
  if (existsSync(LOCK_FILE)) {
    const raw = readFileSync(LOCK_FILE, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isNaN(pid) || pid <= 0) {
      // Corrupted lock file; remove and re-acquire
    } else {
      try {
        process.kill(pid, 0);
        return false; // Process alive, lock held
      } catch {
        // Stale lock from dead process
      }
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  return true;
};

const releaseLock = () => {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // Ignore
  }
};

if (!acquireLock()) {
  console.log("Another ingestion process is running, exiting.");
  process.exit(0);
}

process.on("exit", releaseLock);
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(0);
});
process.on("SIGINT", () => {
  releaseLock();
  process.exit(0);
});

// ── ScopedDb wrapper ────────────────────────────────────
// Case law tables are global (no organizationId). We wrap
// in a transaction to satisfy the ScopedDb interface.

// SAFETY: case law tables are global (no organizationId/RLS).
// The transaction type satisfies ScopedDb's callback parameter
// because both are Drizzle transaction objects from the same db.
const scopedDb: ScopedDb = async (fn) =>
  await db.transaction(async (tx) => await fn(tx));

// ── Cursor recovery ─────────────────────────────────────

/** Coerce a Date or string to YYYY-MM-DD. */
const toIsoDate = (d: unknown): string | null => {
  if (d === null || d === undefined || d === "") {
    return null;
  }
  if (d instanceof Date) {
    return d.toISOString().split("T")[0] ?? null;
  }
  if (typeof d !== "string" && typeof d !== "number") {
    return null;
  }
  const m = String(d).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/** Page sizes per adapter (must match each adapter's constant). */
const PAGE_SIZES: Partial<Record<string, number>> = {
  [ADAPTER_KEYS.CZ_REGIONAL]: 100,
  [ADAPTER_KEYS.CZ_SUPREME_ADMIN]: 20,
  [ADAPTER_KEYS.SK_COURTS]: 25,
  [ADAPTER_KEYS.PL_COURTS]: 50,
};

/**
 * Derive a resume cursor from existing decisions when
 * syncCursor is null. Avoids re-fetching everything
 * after a cursor loss or instance replacement.
 */
const deriveCursor = async (
  sourceId: string,
  adapterKey: string,
): Promise<string | null> => {
  const [stats] = await db
    .select({
      total: count(),
      latestDate: sql<string>`MAX(decision_date)`,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));

  if (!stats || stats.total === 0) {
    return null;
  }

  const total = stats.total;
  const latest = toIsoDate(stats.latestDate);
  const today = new Date().toISOString().split("T")[0] ?? "2026-01-01";

  console.log(
    `[${adapterKey}] Deriving cursor: ${total} decisions, latest: ${latest}`,
  );

  switch (adapterKey) {
    // Date-based adapters go forward in time (date → next day).
    // Resume from the latest sane date so we pick up new decisions.
    // For cz-regional which also needs historical backfill, the
    // adapter's default lookback handles starting further back
    // when cursor is null; here we only recover a lost cursor.
    case ADAPTER_KEYS.CZ_REGIONAL:
    case ADAPTER_KEYS.CZ_SUPREME_ADMIN: {
      const date = latest && latest <= today ? latest : today;
      return `${date}:0`;
    }

    // Position-based: resume from count
    case ADAPTER_KEYS.CZ_SUPREME:
      return String(total + 1);

    // Case-number enumeration: adapter goes backwards from current
    // year to 1993. Resume from the earliest year we have, so it
    // continues going further back in time.
    case ADAPTER_KEYS.CZ_CONSTITUTIONAL: {
      const [earliest] = await db
        .select({
          earliestDate: sql<string>`MIN(decision_date)`,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId));
      const earliestDate = toIsoDate(earliest?.earliestDate);
      const year = earliestDate
        ? Number(earliestDate.split("-")[0])
        : new Date().getFullYear();
      return Number.isNaN(year) ? null : `1:${year}`;
    }

    // Page-based: resume from estimated page
    case ADAPTER_KEYS.SK_COURTS:
    case ADAPTER_KEYS.PL_COURTS: {
      const pageSize = PAGE_SIZES[adapterKey] ?? 25;
      return String(Math.floor(total / pageSize));
    }

    default:
      return null;
  }
};

// ── Adapters to run ─────────────────────────────────────

const ENABLED_ADAPTERS = [
  ADAPTER_KEYS.CZ_REGIONAL,
  ADAPTER_KEYS.CZ_SUPREME,
  ADAPTER_KEYS.CZ_SUPREME_ADMIN,
  ADAPTER_KEYS.CZ_CONSTITUTIONAL,
  ADAPTER_KEYS.SK_COURTS,
  ADAPTER_KEYS.PL_COURTS,
];

// ── Main loop ───────────────────────────────────────────

const CYCLE_DELAY_MS = 5000;

/** Run a single adapter's pipeline cycle. */
const runAdapter = async (key: string) => {
  const rows = await db
    .select()
    .from(caseLawSources)
    .where(eq(caseLawSources.adapterKey, key))
    .limit(1);

  let source = rows[0];

  if (!source) {
    const [inserted] = await db
      .insert(caseLawSources)
      .values({
        adapterKey: key,
        name: key,
        enabled: true,
        syncCursor: null,
      })
      .returning();
    if (!inserted) {
      console.error(`[${key}] Failed to create source`);
      return;
    }
    source = inserted;
    console.log(`[${key}] Created source`);
  }

  // Auto-recover cursor from existing decisions
  if (!source.syncCursor) {
    const derived = await deriveCursor(source.id, key);
    if (derived) {
      console.log(`[${key}] Recovered cursor: ${derived}`);
      await db
        .update(caseLawSources)
        .set({ syncCursor: derived })
        .where(eq(caseLawSources.id, source.id));
      source = { ...source, syncCursor: derived };
    }
  }

  console.log(`[${key}] syncCursor: ${source.syncCursor ?? "null"}`);

  try {
    const result = await runIngestionPipeline({ source, scopedDb });
    console.log(
      `[${key}] +${result.inserted} ins, ` +
        `${result.skipped} skip, ` +
        `svf: ${result.searchVectorFailures}, ` +
        `next: ${result.nextCursor}`,
    );
  } catch (error) {
    console.error(
      `[${key}] ERROR:`,
      error instanceof Error ? error.message : error,
    );
  }
};

/** Run all adapters concurrently. Each adapter hits a different
 *  website, so parallel execution is safe and ~6x faster. */
const runCycle = async () => {
  console.log(`[${new Date().toISOString()}] Starting ingestion cycle`);
  await Promise.allSettled(ENABLED_ADAPTERS.map(runAdapter));
};

console.log(`Ingestion runner started (PID ${process.pid})`);

while (true) {
  try {
    await runCycle();
  } catch (error) {
    console.error("Cycle error:", error);
  }
  await Bun.sleep(CYCLE_DELAY_MS);
}
