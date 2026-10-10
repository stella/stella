import { panic } from "better-result";
/**
 * Case law adapter health report.
 *
 * Queries the database and reports per-adapter health
 * metrics: decision counts, growth, fulltext coverage,
 * stuck cursor detection, field completeness, and more.
 *
 * Outputs structured JSON that Claude Code (or a cron
 * task) can reason about to diagnose and fix issues.
 *
 * Usage:
 *   bun apps/api/src/scripts/adapter-health.ts
 *   bun apps/api/src/scripts/adapter-health.ts --all --json
 *   bun apps/api/src/scripts/adapter-health.ts --adapter cz-ns
 *   bun apps/api/src/scripts/adapter-health.ts --adapter cz-ns --json
 *   bun apps/api/src/scripts/adapter-health.ts --adapter cz-ns --since 24h
 */
import { eq } from "drizzle-orm";

import { printError } from "@stll/errors";

import { caseLawSources } from "@/api/db/schema";
import { loadAdapterByKey } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry-lazy";
import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";
import { boundedAll } from "@/api/lib/db/bounded-all";
import {
  CASE_LAW_SOURCE_ROWS_BOUND,
  CASE_LAW_SOURCE_ROWS_INVARIANT,
} from "@/api/lib/legal-search/ingestion-constants";
import type { SourceTotalCount } from "@/api/lib/legal-search/ingestion-types";
import {
  createUnrecognizedSourceReporter,
  sourceRegistryMembership,
} from "@/api/lib/legal-search/source-registry-membership";
import {
  CHECKED_FIELDS,
  readAdapterHealthMetrics,
} from "@/api/scripts/adapter-health-query";

// This tool only reads; the read-only session makes that a property of every
// transaction rather than a promise, and takes no maintenance lane.
const { rootDb } = await openCaseLawReadOnlySession();
// ── Types ───────────────────────────────────────────────

type FieldCoverage = {
  field: string;
  total: number;
  present: number;
  /** Percentage of rows where the field is non-null. */
  pct: number;
};

type GrowthWindow = {
  /** ISO timestamp of the window start. */
  since: string;
  /** Decisions inserted in this window. */
  inserted: number;
  /** Average decisions per hour in this window. */
  perHour: number;
};

type AdapterReport = {
  adapterKey: string;
  /**
   * False when no adapter is registered for `adapterKey`. Kept apart from a
   * null `remoteTotal`, which a registered adapter also reports when its probe
   * fails or its publisher states no total.
   */
  adapterRegistered: boolean;
  name: string;
  enabled: boolean;
  sourceId: string;

  /** Current sync cursor value. */
  syncCursor: string | null;
  /** ISO timestamp of last sync. */
  lastSyncAt: string | null;
  /** Hours since last sync (null if never synced). */
  hoursSinceSync: number | null;

  /** Total decisions in DB for this adapter. */
  totalDecisions: number;
  /** Total decisions on the court website (null if unknown). */
  remoteTotal: number | null;
  /** DB decisions / remote total as percentage (null if unknown). */
  coveragePct: number | null;
  /** Growth in the reporting window. */
  growth: GrowthWindow;

  /** Fulltext coverage stats. */
  fulltext: {
    withFulltext: number;
    withoutFulltext: number;
    pct: number;
  };

  /** Search index coverage. */
  searchIndex: {
    indexed: number;
    notIndexed: number;
    pct: number;
  };

  /** Citation stats. */
  citations: {
    total: number;
    resolved: number;
    unresolved: number;
    resolutionPct: number;
  };

  /** Field-level completeness for key columns. */
  fields: FieldCoverage[];

  /** Flags for issues that need attention. */
  issues: string[];
};

type HealthReport = {
  /** ISO timestamp when the report was generated. */
  generatedAt: string;
  /** Reporting window in hours. */
  windowHours: number;
  adapters: AdapterReport[];
  summary: {
    totalDecisions: number;
    totalCitations: number;
    healthyCount: number;
    degradedCount: number;
    stuckCount: number;
  };
};

// ── Config ──────────────────────────────────────────────

/** Adapter is "stuck" if no growth in this many hours. */
const STUCK_THRESHOLD_HOURS = 12;

/** Flag an issue when coverage drops below this percentage. */
const COVERAGE_THRESHOLD_PCT = 80;

/** Issue prefix for stuck detection (used in summary counts). */
const STUCK_PREFIX = "Stuck:" as const;

/** Timeout for each remote total fetch (ms). */
// The slowest total is the NSS full-range count, which the source itself
// takes tens of seconds to produce; the budget must exceed the adapter's
// own request timeout or the probe aborts first and reports a false blind
// spot.
const SOURCE_TOTAL_TIMEOUT = 120_000;

// ── Helpers ─────────────────────────────────────────────

const parseWindowArg = (args: readonly string[]): number => {
  const idx = args.indexOf("--since");
  if (idx === -1 || idx + 1 >= args.length) {
    return 24; // default: 24h
  }
  const raw = args.at(idx + 1);
  if (!raw) {
    return 24;
  }
  const match = /^(?<hours>\d+)\s*h$/iu.exec(raw);
  if (match?.groups?.["hours"]) {
    return Number.parseInt(match.groups["hours"], 10);
  }
  return 24;
};

const parseAdapterArg = (args: readonly string[]): string | null => {
  const index = args.indexOf("--adapter");
  const value = index === -1 ? undefined : args.at(index + 1)?.trim();
  return value && !value.startsWith("--") && value.length <= 64 ? value : null;
};

type ReportScope = { type: "all" } | { type: "adapter"; adapterKey: string };

const parseReportScope = (args: readonly string[]): ReportScope => {
  const adapterKey = parseAdapterArg(args);
  if (args.includes("--all") && args.includes("--adapter")) {
    return panic("Pass --all or --adapter <key>, not both.");
  }
  if (args.includes("--adapter") && adapterKey === null) {
    return panic("Pass a valid --adapter <key>.");
  }
  return adapterKey === null
    ? { type: "all" }
    : { type: "adapter", adapterKey };
};

// ── Source total fetchers ────────────────────────────────

/**
 * The denominator this report prints beside a held count, or null where there
 * is none.
 *
 * Both non-count answers collapse here, and deliberately: a coverage
 * percentage needs a denominator, and neither a publisher that states no total
 * nor a probe that broke supplies one. The distinction is kept by the standing
 * totals sweep, which acts on it; this report only renders what it has.
 */
const remoteTotalOf = (answer: SourceTotalCount): number | null => {
  switch (answer.type) {
    case "count":
      return answer.total;
    case "no-count-endpoint":
    case "probe-failed":
      return null;
    default: {
      answer satisfies never;
      return panic(`Unhandled source total: ${JSON.stringify(answer)}`);
    }
  }
};

/**
 * Fetch the named adapter's publisher total with its own timeout.
 * A key with no registered adapter returns null.
 */
const getSourceTotal = async (adapterKey: string): Promise<number | null> => {
  try {
    const adapter = await loadAdapterByKey(adapterKey);
    if (!adapter) {
      return null;
    }
    const signal = AbortSignal.timeout(SOURCE_TOTAL_TIMEOUT);
    return remoteTotalOf(await adapter.getTotalCount(signal));
  } catch {
    return null;
  }
};

// ── Queries ─────────────────────────────────────────────

const SOURCE_SELECTION = {
  id: caseLawSources.id,
  adapterKey: caseLawSources.adapterKey,
  name: caseLawSources.name,
  enabled: caseLawSources.enabled,
  syncCursor: caseLawSources.syncCursor,
  lastSyncAt: caseLawSources.lastSyncAt,
} as const;

const getSource = async (adapterKey: string) => {
  const [source] = await rootDb.transaction(async (tx) =>
    tx
      .select(SOURCE_SELECTION)
      .from(caseLawSources)
      .where(eq(caseLawSources.adapterKey, adapterKey))
      .limit(1),
  );
  return source ?? panic(`No case-law source has adapter key ${adapterKey}.`);
};

const getSources = async () =>
  await boundedAll({
    invariant: CASE_LAW_SOURCE_ROWS_INVARIANT,
    max: CASE_LAW_SOURCE_ROWS_BOUND,
    table: "case_law_sources",
    query: async (limit) =>
      await rootDb.transaction(async (tx) =>
        tx
          .select(SOURCE_SELECTION)
          .from(caseLawSources)
          .orderBy(caseLawSources.adapterKey)
          .limit(limit),
      ),
  });

const parseFieldCoverage = (
  fields: ReadonlyMap<(typeof CHECKED_FIELDS)[number], number>,
  total: number,
): FieldCoverage[] =>
  CHECKED_FIELDS.map((field) => {
    const present =
      fields.get(field) ?? panic(`Missing adapter health field ${field}.`);
    return {
      field,
      total,
      present,
      pct: total > 0 ? Math.round((present / total) * 1000) / 10 : 0,
    };
  });

// ── Main ────────────────────────────────────────────────

const buildReport = async (
  windowHours: number,
  scope: ReportScope,
): Promise<HealthReport> => {
  const now = new Date();
  const sinceDate = new Date(now.getTime() - windowHours * 3_600_000);
  const sources =
    scope.type === "all"
      ? await getSources()
      : [await getSource(scope.adapterKey)];

  const adapters: AdapterReport[] = [];
  const reportUnrecognizedSource = createUnrecognizedSourceReporter(
    "case_law.adapter_health",
  );

  // Finish a source's local metrics and remote probe before the next source.
  const addSourceReport = async (index: number): Promise<void> => {
    const source = sources.at(index);
    if (source === undefined) {
      return;
    }
    const metrics = await readAdapterHealthMetrics({
      db: rootDb,
      sourceId: source.id,
      sinceDate,
    });
    const remoteTotal = await getSourceTotal(source.adapterKey);
    const total = metrics.total;
    const inserted = metrics.inserted;
    const si = {
      indexed: metrics.indexed,
      notIndexed: total - metrics.indexed,
    };
    const cit = {
      total: metrics.citationTotal,
      resolved: metrics.citationResolved,
    };

    const hoursSinceSync = source.lastSyncAt
      ? (now.getTime() - source.lastSyncAt.getTime()) / 3_600_000
      : null;

    const fields = parseFieldCoverage(metrics.fields, total);

    // Derive fulltext coverage from field coverage
    const fulltextField = fields.find((f) => f.field === "fulltext");
    const withFulltext = fulltextField?.present ?? 0;
    const withoutFulltext = total - withFulltext;

    // A missing registry adapter and a failed total probe both report null;
    // membership remains explicit so the operator can tell them apart.
    const membership = sourceRegistryMembership(source.adapterKey);
    const adapterRegistered = membership.type === "registered";
    if (!adapterRegistered) {
      reportUnrecognizedSource(source.adapterKey);
    }

    // Remote source total
    const coveragePct =
      remoteTotal !== null && remoteTotal > 0
        ? Math.round((total / remoteTotal) * 1000) / 10
        : null;

    // Detect issues
    const issues: string[] = [];

    // Stuck detection uses lastSyncAt exclusively: if the
    // adapter hasn't synced in STUCK_THRESHOLD_HOURS, it's
    // stuck regardless of what the growth window shows.
    if (
      source.enabled &&
      hoursSinceSync !== null &&
      hoursSinceSync > STUCK_THRESHOLD_HOURS
    ) {
      issues.push(`${STUCK_PREFIX} no sync in ${Math.round(hoursSinceSync)}h`);
    }

    if (source.enabled && source.syncCursor === null && total > 0) {
      issues.push("Cursor is NULL despite having decisions");
    }

    const ftPct =
      total > 0 ? Math.round((withFulltext / total) * 1000) / 10 : 0;
    if (total > 100 && ftPct < 50) {
      issues.push(`Low fulltext coverage: ${ftPct}%`);
    }

    const siTotal = si.indexed + si.notIndexed;
    const siPct =
      siTotal > 0 ? Math.round((si.indexed / siTotal) * 1000) / 10 : 0;
    if (total > 100 && siPct < 90) {
      issues.push(`Search index gap: ${siPct}% indexed`);
    }

    if (!source.enabled && total > 0) {
      issues.push("Adapter disabled but has decisions");
    }

    if (!adapterRegistered) {
      issues.push(
        `No adapter registered for "${source.adapterKey}": retired source, or a seeded/test row. Nothing will ingest into it.`,
      );
    }

    if (
      remoteTotal !== null &&
      coveragePct !== null &&
      coveragePct < COVERAGE_THRESHOLD_PCT
    ) {
      issues.push(
        `Low source coverage:` +
          ` ${total.toLocaleString()}` +
          `/${remoteTotal.toLocaleString()}` +
          ` (${coveragePct}%)`,
      );
    }

    adapters.push({
      adapterKey: source.adapterKey,
      adapterRegistered,
      name: source.name,
      enabled: source.enabled,
      sourceId: source.id,
      syncCursor: source.syncCursor,
      lastSyncAt: source.lastSyncAt?.toISOString() ?? null,
      hoursSinceSync:
        hoursSinceSync !== null ? Math.round(hoursSinceSync * 10) / 10 : null,
      totalDecisions: total,
      remoteTotal,
      coveragePct,
      growth: {
        since: sinceDate.toISOString(),
        inserted,
        perHour:
          windowHours > 0 ? Math.round((inserted / windowHours) * 10) / 10 : 0,
      },
      fulltext: {
        withFulltext,
        withoutFulltext,
        pct: ftPct,
      },
      searchIndex: {
        indexed: si.indexed,
        notIndexed: si.notIndexed,
        pct: siPct,
      },
      citations: {
        total: cit.total,
        resolved: cit.resolved,
        unresolved: cit.total - cit.resolved,
        resolutionPct:
          cit.total > 0
            ? Math.round((cit.resolved / cit.total) * 1000) / 10
            : 0,
      },
      fields,
      issues,
    });
    await addSourceReport(index + 1);
  };
  await addSourceReport(0);

  // Summary
  const totalDecisions = adapters.reduce((sum, a) => sum + a.totalDecisions, 0);
  const totalCitations = adapters.reduce(
    (sum, a) => sum + a.citations.total,
    0,
  );
  const stuckCount = adapters.filter((a) =>
    a.issues.some((i) => i.startsWith(STUCK_PREFIX)),
  ).length;
  // An adapter can be both stuck and degraded; count any
  // adapter with a non-stuck issue as degraded.
  const degradedCount = adapters.filter((a) =>
    a.issues.some((i) => !i.startsWith(STUCK_PREFIX)),
  ).length;
  const healthyCount = adapters.filter(
    (a) => a.enabled && a.issues.length === 0,
  ).length;

  return {
    generatedAt: now.toISOString(),
    windowHours,
    adapters,
    summary: {
      totalDecisions,
      totalCitations,
      healthyCount,
      degradedCount,
      stuckCount,
    },
  };
};

// ── CLI output ──────────────────────────────────────────

const formatTable = (report: HealthReport): string => {
  const lines: string[] = [
    `Case Law Health Report — ${report.generatedAt}`,
    `Window: ${report.windowHours}h`,
    "",
  ];

  for (const a of report.adapters) {
    const status = (() => {
      if (a.issues.length === 0) {
        return (() => {
          if (a.enabled) {
            return "OK";
          }
          return "OFF";
        })();
      }
      return "!!";
    })();

    lines.push(`[${status}] ${a.adapterKey} (${a.name})`);
    const remoteSuffix =
      a.remoteTotal !== null
        ? ` / ${a.remoteTotal.toLocaleString()} remote (${a.coveragePct ?? "?"}%)`
        : "";
    lines.push(
      `  Decisions: ${a.totalDecisions.toLocaleString()}${remoteSuffix} | Growth: +${a.growth.inserted.toLocaleString()} (${a.growth.perHour}/h)`,
    );
    lines.push(
      `  Fulltext: ${a.fulltext.pct}%` +
        ` | Search: ${a.searchIndex.pct}%` +
        ` | Citations: ${a.citations.total.toLocaleString()}` +
        ` (${a.citations.resolutionPct}% resolved)`,
    );
    lines.push(
      `  Cursor: ${a.syncCursor ?? "NULL"}` +
        ` | Last sync: ${a.hoursSinceSync !== null ? `${a.hoursSinceSync}h ago` : "never"}`,
    );

    // Show fields below 100%
    const incomplete = a.fields.filter((f) => f.pct < 100 && f.total > 0);
    if (incomplete.length > 0) {
      const fieldStr = incomplete.map((f) => `${f.field}=${f.pct}%`).join(", ");
      lines.push(`  Fields: ${fieldStr}`);
    }

    for (const issue of a.issues) {
      lines.push(`  !! ${issue}`);
    }

    lines.push("");
  }

  const s = report.summary;
  lines.push(
    `Total: ${s.totalDecisions.toLocaleString()} decisions,` +
      ` ${s.totalCitations.toLocaleString()} citations`,
  );
  lines.push(
    `${s.healthyCount} healthy,` +
      ` ${s.degradedCount} degraded,` +
      ` ${s.stuckCount} stuck`,
  );

  return lines.join("\n");
};

// ── Entry point ─────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const windowHours = parseWindowArg(args);

  try {
    const report = await buildReport(windowHours, parseReportScope(args));

    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatTable(report));
    }

    // Exit 1 if any enabled adapter has issues
    const hasIssues = report.adapters.some(
      (a) => a.enabled && a.issues.length > 0,
    );
    process.exit(hasIssues ? 1 : 0);
  } catch (error) {
    printError("Health check failed:", error);
    process.exit(2);
  }
}

export { buildReport, formatTable };
export type { AdapterReport, HealthReport };
