/**
 * Continuous case law ingestion daemon.
 *
 * Loops through all configured court adapters, runs one
 * pipeline cycle per source, sleeps, and repeats. Cursors
 * are persisted in RDS after each cycle; safe to restart
 * at any time.
 *
 * Usage:
 *   bun apps/api/scripts/ingest-case-law.ts [adapter-key]
 *
 * Without arguments, runs all sources in a continuous loop.
 * With an adapter key, runs only that source once and exits.
 */

import { createScopedDb, db } from "@/api/db";
import { caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import { toSafeId } from "@/api/lib/branded-types";

type SourceDef = {
  adapterKey: string;
  name: string;
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
  console.log(
    `Disabled adapters: ${[...DISABLED_ADAPTER_KEYS].join(", ")}`,
  );
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

const filterKey = process.argv[2];

const main = async () => {
  const toRun = filterKey
    ? SOURCES.filter((s) => s.adapterKey === filterKey)
    : SOURCES;

  if (toRun.length === 0) {
    console.error(
      `Unknown adapter: ${filterKey}. ` +
        `Valid keys: ${SOURCES.map((s) => s.adapterKey).join(", ")}`,
    );
    process.exit(1);
  }

  const results = await Promise.allSettled(
    toRun.map(async ({ adapterKey, name }) => {
      const initialCursor =
        adapterKey === ADAPTER_KEYS.CZ_REGIONAL ? daysAgoCursor(7) : null;

      const source = await ensureSource(adapterKey, name, initialCursor);

      console.log(
        `\nIngesting: ${name} (cursor: ${source.syncCursor ?? "start"})`,
      );

      // SAFETY: CLI script operates on global case law
      // data (no tenant).
      const scopedDb = createScopedDb(db, [], toSafeId<"organization">(""));
      const result = await runIngestionPipeline({
        source,
        scopedDb,
      });

      console.log(
        `  Inserted: ${result.inserted}, ` +
          `Skipped: ${result.skipped}, ` +
          `Search failures: ${result.searchVectorFailures}`,
      );
      console.log(`  Next cursor: ${result.nextCursor ?? "done"}`);
    }),
  );

  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );

  for (const { reason } of failures) {
    console.error("Adapter error:", reason);
  }

  console.log("\nCycle complete.");

  if (failures.length > 0) {
    throw new Error(`${failures.length} adapter(s) failed`);
  }
};

const CYCLE_DELAY_MS = 5000;

// Single adapter: run once and exit (useful for debugging).
if (filterKey) {
  await main().catch((error: unknown) => {
    console.error("Ingestion failed:", error);
    process.exit(1);
  });
  process.exit(0);
}

// All adapters: continuous daemon loop.
console.log("Ingestion daemon started.");
while (true) {
  try {
    await main();
  } catch (error: unknown) {
    console.error("Cycle error:", error);
  }
  await Bun.sleep(CYCLE_DELAY_MS);
}
