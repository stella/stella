/* eslint-disable no-console -- CLI script */
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
 *   bun apps/api/src/scripts/adapter-health.ts --json
 *   bun apps/api/src/scripts/adapter-health.ts --since 24h
 */

import { count, eq, gt, sql } from "drizzle-orm";

import { db } from "@/api/db/root";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import {
  listAdapterKeys,
  loadAdapterByKey,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry-lazy";
import { isRecord } from "@/api/lib/type-guards";

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

/** Fields to check for completeness, mapped to Drizzle columns. */
const FIELD_COLUMN_MAP = {
  ecli: caseLawDecisions.ecli,
  decision_date: caseLawDecisions.decisionDate,
  decision_type: caseLawDecisions.decisionType,
  fulltext: caseLawDecisions.fulltext,
  source_url: caseLawDecisions.sourceUrl,
  document_url: caseLawDecisions.documentUrl,
  source_hash: caseLawDecisions.sourceHash,
} as const;
const CHECKED_FIELDS = [
  "ecli",
  "decision_date",
  "decision_type",
  "fulltext",
  "source_url",
  "document_url",
  "source_hash",
] as const satisfies readonly (keyof typeof FIELD_COLUMN_MAP)[];

/** Adapter is "stuck" if no growth in this many hours. */
const STUCK_THRESHOLD_HOURS = 12;

/** Flag an issue when coverage drops below this percentage. */
const COVERAGE_THRESHOLD_PCT = 80;

/** Issue prefix for stuck detection (used in summary counts). */
const STUCK_PREFIX = "Stuck:" as const;

/** Timeout for each remote total fetch (ms). */
const SOURCE_TOTAL_TIMEOUT = 10_000;

// ── Helpers ─────────────────────────────────────────────

const parseWindowArg = (args: string[]): number => {
  const idx = args.indexOf("--since");
  if (idx === -1 || idx + 1 >= args.length) {
    return 24; // default: 24h
  }
  const raw = args.at(idx + 1);
  if (!raw) {
    return 24;
  }
  const match = raw.match(/^(\d+)\s*h$/i);
  if (match?.[1]) {
    return Number.parseInt(match[1], 10);
  }
  return 24;
};

// ── Source total fetchers ────────────────────────────────

type SourceTotal = {
  adapterKey: string;
  remoteTotal: number | null;
};

/**
 * Fetch the total available decisions from each court
 * website via the adapter's `getTotalCount` method.
 * Each fetch is independent and has its own timeout.
 * Adapters without `getTotalCount` return null.
 */
const getSourceTotals = async (): Promise<SourceTotal[]> => {
  const keys = listAdapterKeys();

  return await Promise.all(
    keys.map(async (adapterKey: string) => {
      try {
        const adapter = await loadAdapterByKey(adapterKey);
        if (!adapter?.getTotalCount) {
          return { adapterKey, remoteTotal: null };
        }
        const signal = AbortSignal.timeout(SOURCE_TOTAL_TIMEOUT);
        const remoteTotal = await adapter.getTotalCount(signal);
        return { adapterKey, remoteTotal };
      } catch {
        return { adapterKey, remoteTotal: null };
      }
    }),
  );
};

// ── Queries ─────────────────────────────────────────────

const getSources = () =>
  db
    .select({
      id: caseLawSources.id,
      adapterKey: caseLawSources.adapterKey,
      name: caseLawSources.name,
      enabled: caseLawSources.enabled,
      syncCursor: caseLawSources.syncCursor,
      lastSyncAt: caseLawSources.lastSyncAt,
    })
    .from(caseLawSources)
    .orderBy(caseLawSources.adapterKey);

const getDecisionCounts = () =>
  db
    .select({
      sourceId: caseLawDecisions.sourceId,
      total: count(),
    })
    .from(caseLawDecisions)
    .groupBy(caseLawDecisions.sourceId);

const getGrowthCounts = (sinceDate: Date) =>
  db
    .select({
      sourceId: caseLawDecisions.sourceId,
      inserted: count(),
    })
    .from(caseLawDecisions)
    .where(gt(caseLawDecisions.createdAt, sinceDate))
    .groupBy(caseLawDecisions.sourceId);

const getSearchIndexCoverage = () =>
  db
    .select({
      sourceId: caseLawDecisions.sourceId,
      isIndexed:
        sql<boolean>`${caseLawSearchDocuments.decisionId} IS NOT NULL`.as(
          "is_indexed",
        ),
      cnt: count(),
    })
    .from(caseLawDecisions)
    .leftJoin(
      caseLawSearchDocuments,
      eq(caseLawDecisions.id, caseLawSearchDocuments.decisionId),
    )
    .groupBy(
      caseLawDecisions.sourceId,
      sql`${caseLawSearchDocuments.decisionId} IS NOT NULL`,
    );

const getCitationStats = () =>
  db
    .select({
      sourceId: caseLawDecisions.sourceId,
      total: count(),
      resolved:
        sql<number>`COUNT(*) FILTER (WHERE ${caseLawCitations.citedDecisionId} IS NOT NULL)`.as(
          "resolved",
        ),
    })
    .from(caseLawCitations)
    .innerJoin(
      caseLawDecisions,
      eq(caseLawCitations.citingDecisionId, caseLawDecisions.id),
    )
    .groupBy(caseLawDecisions.sourceId);

/**
 * Single query: counts non-null/non-empty values for all
 * checked fields per source, avoiding N+1 per-field queries.
 */
const getAllFieldCoverage = () => {
  const fieldColumns = Object.fromEntries(
    CHECKED_FIELDS.map((field) => {
      const col = FIELD_COLUMN_MAP[field];
      return [
        field,
        sql<number>`COUNT(*) FILTER (WHERE ${col} IS NOT NULL AND ${col}::text != '')`.as(
          field,
        ),
      ];
    }),
  );

  return db
    .select({
      sourceId: caseLawDecisions.sourceId,
      total: count(),
      ...fieldColumns,
    })
    .from(caseLawDecisions)
    .groupBy(caseLawDecisions.sourceId);
};

const parseFieldCoverage = (
  row: Record<string, unknown>,
  total: number,
): FieldCoverage[] =>
  CHECKED_FIELDS.map((field) => {
    const present = Number(row[field] ?? 0);
    return {
      field,
      total,
      present,
      pct: total > 0 ? Math.round((present / total) * 1000) / 10 : 0,
    };
  });

// ── Main ────────────────────────────────────────────────

const buildReport = async (windowHours: number): Promise<HealthReport> => {
  const now = new Date();
  const sinceDate = new Date(now.getTime() - windowHours * 3_600_000);

  // Run independent queries in parallel
  const [
    sources,
    decisionCounts,
    growthCounts,
    searchIndexRows,
    citationRows,
    fieldCoverageRows,
    sourceTotals,
  ] = await Promise.all([
    getSources(),
    getDecisionCounts(),
    getGrowthCounts(sinceDate),
    getSearchIndexCoverage(),
    getCitationStats(),
    getAllFieldCoverage(),
    getSourceTotals(),
  ]);

  // Index by sourceId for fast lookup
  const countMap = new Map<string, number>(
    decisionCounts.map((r: { sourceId: string; total: number }) => [
      r.sourceId,
      Number(r.total),
    ]),
  );
  const growthMap = new Map<string, number>(
    growthCounts.map((r: { sourceId: string; inserted: number }) => [
      r.sourceId,
      Number(r.inserted),
    ]),
  );

  // Search index: { sourceId → { indexed, notIndexed } }
  const searchMap = new Map<string, { indexed: number; notIndexed: number }>();
  for (const row of searchIndexRows) {
    const entry = searchMap.get(row.sourceId) ?? {
      indexed: 0,
      notIndexed: 0,
    };
    if (row.isIndexed) {
      entry.indexed = Number(row.cnt);
    } else {
      entry.notIndexed = Number(row.cnt);
    }
    searchMap.set(row.sourceId, entry);
  }

  // Citations: { sourceId → { total, resolved } }
  const citationMap = new Map<string, { total: number; resolved: number }>(
    citationRows.map(
      (r: { sourceId: string; total: number; resolved: number }) => [
        r.sourceId,
        { total: Number(r.total), resolved: Number(r.resolved) },
      ],
    ),
  );

  // Field coverage: { sourceId → row }
  const fieldCoverageMap = new Map(
    fieldCoverageRows.map(
      (r: { sourceId: string; total: number } & Record<string, unknown>) => [
        r.sourceId,
        r,
      ],
    ),
  );

  // Remote totals: { adapterKey → remoteTotal }
  const sourceTotalMap = new Map<string, number | null>(
    sourceTotals.map((r: SourceTotal) => [r.adapterKey, r.remoteTotal]),
  );

  // Build per-adapter reports
  const adapters: AdapterReport[] = [];

  for (const source of sources) {
    const total = countMap.get(source.id) ?? 0;
    const inserted = growthMap.get(source.id) ?? 0;
    const si = searchMap.get(source.id) ?? {
      indexed: 0,
      notIndexed: 0,
    };
    const cit = citationMap.get(source.id) ?? {
      total: 0,
      resolved: 0,
    };

    const hoursSinceSync = source.lastSyncAt
      ? (now.getTime() - source.lastSyncAt.getTime()) / 3_600_000
      : null;

    const fcRow = fieldCoverageMap.get(source.id);
    const fcRecord = isRecord(fcRow) ? fcRow : undefined;
    const fields = fcRecord ? parseFieldCoverage(fcRecord, total) : [];

    // Derive fulltext coverage from field coverage
    const fulltextField = fields.find((f) => f.field === "fulltext");
    const withFulltext = fulltextField?.present ?? 0;
    const withoutFulltext = total - withFulltext;

    // Remote source total
    const remoteTotal = sourceTotalMap.get(source.adapterKey) ?? null;
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
  }

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
    const status = a.issues.length === 0 ? (a.enabled ? "OK" : "OFF") : "!!";

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
    const report = await buildReport(windowHours);

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
    console.error("Health check failed:", error);
    process.exit(2);
  }
}

export { buildReport, formatTable };
export type { AdapterReport, HealthReport };
