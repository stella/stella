/* eslint-disable no-console -- CLI script */
/**
 * Adapter health checks.
 *
 * Verifies each registered adapter can still fetch data
 * from its source and that results have the expected
 * shape. Run periodically (e.g. daily cron) to detect
 * broken adapters before users notice.
 *
 * Usage:
 *   bun run apps/api/src/handlers/case-law/ingestion/adapters/health-check.ts
 *
 * Or import `checkAdapterHealth` / `checkAllAdapters`
 * for use in tests or monitoring endpoints.
 */

import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  ADAPTER_MODULES,
  loadAdapterByKey,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry-lazy";

type LoadResult =
  | { adapter: SourceAdapter; key: string }
  | { key: string; importError: string };

const loadAllAdapters = async (): Promise<LoadResult[]> => {
  const results: LoadResult[] = [];
  for (const key of Object.keys(ADAPTER_MODULES)) {
    try {
      const adapter = await loadAdapterByKey(key);
      if (adapter) {
        results.push({ adapter, key });
      } else {
        results.push({
          key,
          importError: "Module loaded but no SourceAdapter export found",
        });
      }
    } catch (error) {
      results.push({
        key,
        importError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
};

export type FieldCheck = {
  field: string;
  present: number;
  missing: number;
  /** Example values (first 3 non-empty). */
  examples: string[];
};

export type HealthResult = {
  key: string;
  name: string;
  status: "healthy" | "degraded" | "down";
  decisionCount: number;
  hasNextCursor: boolean;
  fields: FieldCheck[];
  durationMs: number;
  error?: string;
};

/** Fields that every decision must have. */
const REQUIRED_FIELDS: (keyof IngestionResult)[] = [
  "caseNumber",
  "court",
  "country",
  "language",
  "rawHash",
];

/** Fields that should be present on most decisions. */
const EXPECTED_FIELDS: (keyof IngestionResult)[] = [
  "decisionDate",
  "sourceUrl",
];

/** Fields that are valuable but not always available. */
const OPTIONAL_FIELDS: (keyof IngestionResult)[] = [
  "ecli",
  "fulltext",
  "decisionType",
];

const ALL_CHECKED_FIELDS = [
  ...REQUIRED_FIELDS,
  ...EXPECTED_FIELDS,
  ...OPTIONAL_FIELDS,
];

const checkField = (
  decisions: IngestionResult[],
  field: keyof IngestionResult,
): FieldCheck => {
  let present = 0;
  let missing = 0;
  const examples: string[] = [];

  for (const d of decisions) {
    const val = d[field];
    if (val !== undefined && val !== null && val !== "") {
      present++;
      if (examples.length < 3) {
        const str =
          typeof val === "string"
            ? val.slice(0, 80)
            : JSON.stringify(val).slice(0, 80);
        examples.push(str);
      }
    } else {
      missing++;
    }
  }

  return { field, present, missing, examples };
};

/**
 * Run a health check on a single adapter.
 *
 * Calls fetchPage(null, {}) with a timeout and
 * validates the response shape.
 */
export const checkAdapterHealth = async (
  adapter: SourceAdapter,
  timeoutMs = 60_000,
): Promise<HealthResult> => {
  const start = performance.now();

  try {
    const result = await adapter.fetchPage(
      null,
      {},
      AbortSignal.timeout(timeoutMs),
    );

    const durationMs = Math.round(performance.now() - start);

    if (result.isErr()) {
      return {
        key: adapter.key,
        name: adapter.name,
        status: "down",
        decisionCount: 0,
        hasNextCursor: false,
        fields: [],
        durationMs,
        error: result.error.message,
      };
    }

    const page = result.unwrap();
    const fields = ALL_CHECKED_FIELDS.map((f) => checkField(page.decisions, f));

    // Determine status
    const requiredOk = REQUIRED_FIELDS.every((f) => {
      const check = fields.find((c) => c.field === f);
      return check && check.missing === 0;
    });

    const status =
      page.decisions.length === 0
        ? "down"
        : requiredOk
          ? "healthy"
          : "degraded";

    return {
      key: adapter.key,
      name: adapter.name,
      status,
      decisionCount: page.decisions.length,
      hasNextCursor: page.nextCursor !== null,
      fields,
      durationMs,
    };
  } catch (error) {
    return {
      key: adapter.key,
      name: adapter.name,
      status: "down",
      decisionCount: 0,
      hasNextCursor: false,
      fields: [],
      durationMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/** Run health checks on all registered adapters. */
export const checkAllAdapters = async (
  timeoutMs = 60_000,
): Promise<HealthResult[]> => {
  const loaded = await loadAllAdapters();
  const results: HealthResult[] = [];

  for (const entry of loaded) {
    if ("importError" in entry) {
      results.push({
        key: entry.key,
        name: entry.key,
        status: "down",
        decisionCount: 0,
        hasNextCursor: false,
        fields: [],
        durationMs: 0,
        error: `Import failed: ${entry.importError}`,
      });
      continue;
    }

    const result = await checkAdapterHealth(entry.adapter, timeoutMs);
    results.push(result);
  }

  return results;
};

/** Format health results as a human-readable report. */
export const formatHealthReport = (
  results: readonly HealthResult[],
): string => {
  const lines: string[] = ["=== Adapter Health Report ===", ""];

  for (const r of results) {
    const icon =
      r.status === "healthy" ? "OK" : r.status === "degraded" ? "WARN" : "FAIL";

    lines.push(`[${icon}] ${r.key} (${r.name})`);
    lines.push(
      `  Decisions: ${r.decisionCount} | ` +
        `Cursor: ${r.hasNextCursor ? "yes" : "no"} | ` +
        `Time: ${r.durationMs}ms`,
    );

    if (r.error) {
      lines.push(`  Error: ${r.error}`);
    }

    // Show field coverage
    for (const f of r.fields) {
      if (f.missing > 0) {
        const pct = Math.round((f.present / (f.present + f.missing)) * 100);
        lines.push(
          `  ${f.field}: ${pct}% (${f.present}/${f.present + f.missing})`,
        );
      }
    }

    lines.push("");
  }

  const healthy = results.filter((r) => r.status === "healthy").length;
  const total = results.length;
  lines.push(`${healthy}/${total} adapters healthy`);

  return lines.join("\n");
};

// Run as standalone script
if (import.meta.main) {
  console.log("Running adapter health checks...\n");
  const results = await checkAllAdapters();
  console.log(formatHealthReport(results));
  const failed = results.filter(
    (r) => r.status === "down" || r.status === "degraded",
  );
  if (failed.length > 0) {
    process.exit(1);
  }
}
