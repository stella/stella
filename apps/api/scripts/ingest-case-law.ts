/**
 * Run the case law ingestion pipeline for configured sources.
 *
 * Usage:
 *   bun apps/api/scripts/ingest-case-law.ts [adapter-key]
 *
 * Without arguments, runs all sources. With an adapter key,
 * runs only that source (e.g. "cz-regional").
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

const SOURCES: SourceDef[] = [
  {
    adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
    name: "Czech Regional Courts",
  },
  {
    adapterKey: ADAPTER_KEYS.CZ_SUPREME,
    name: "Czech Supreme Court",
  },
  {
    adapterKey: ADAPTER_KEYS.CZ_SUPREME_ADMIN,
    name: "Czech Supreme Administrative Court",
  },
  {
    adapterKey: ADAPTER_KEYS.CZ_CONSTITUTIONAL,
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

const main = async () => {
  const filterKey = process.argv[2];

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

  for (const { adapterKey, name } of toRun) {
    const initialCursor =
      adapterKey === ADAPTER_KEYS.CZ_REGIONAL ? daysAgoCursor(7) : null;

    const source = await ensureSource(adapterKey, name, initialCursor);

    console.log(
      `\nIngesting: ${name} (cursor: ${source.syncCursor ?? "start"})`,
    );

    // SAFETY: CLI script operates on global case law data (no tenant).
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
  }

  console.log("\nDone.");
  process.exit(0);
};

main().catch((error: unknown) => {
  console.error("Ingestion failed:", error);
  process.exit(1);
});
