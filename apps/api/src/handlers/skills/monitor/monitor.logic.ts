import { panic } from "better-result";

import { Temporal } from "@stll/time";

import {
  parseSkillReadAuditMetadata,
  SKILL_READ_OUTCOME,
  SKILL_READ_SURFACE,
} from "@/api/lib/agent-skills/skill-read-audit";

export const SKILL_MONITOR_WINDOWS = [7, 30, 90] as const;

export type SkillMonitorWindowDays = (typeof SKILL_MONITOR_WINDOWS)[number];

export type SkillMonitorAuditRow = {
  createdAt: Date;
  metadata: Record<string, unknown> | null;
  runId: string | null;
  userId: string;
};

type SkillMonitorDailyPoint = {
  contextReads: number;
  date: string;
  users: number;
  uses: number;
};

type SkillMonitorContextFileStat = {
  errors: number;
  path: string;
  reads: number;
};

type SkillMonitorActiveUser = {
  id: string;
  image: string | null;
  name: string | null;
  uses: number;
};

export type SkillMonitorUserProfile = {
  image: string | null;
  name: string | null;
};

export type SkillMonitorSummary = {
  activeUsers: SkillMonitorActiveUser[];
  avgDailyActiveUsers: number;
  chatReads: number;
  contextFiles: SkillMonitorContextFileStat[];
  contextReads: number;
  dailyTrend: SkillMonitorDailyPoint[];
  errorReads: number;
  instructionsReads: number;
  mcpReads: number;
  totalReads: number;
  totalUses: number;
  truncated: boolean;
  uniqueUsers: number;
  windowDays: SkillMonitorWindowDays;
  windowEnd: string;
  windowStart: string;
};

const ACTIVE_USERS_MAX = 20;

const toUtcPlainDate = (date: Date): Temporal.PlainDate =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO("UTC")
    .toPlainDate();

const compareKeys = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

/**
 * Aggregate a skill's `audit_logs` access rows and current resource list into
 * the Monitor dashboard payload. Pure so it can be unit-tested without Postgres.
 */
export const aggregateSkillMonitor = ({
  now,
  resourcePaths,
  rows,
  truncated = false,
  userProfiles,
  windowDays,
}: {
  now: Date;
  resourcePaths: readonly string[];
  rows: readonly SkillMonitorAuditRow[];
  truncated?: boolean;
  userProfiles?: ReadonlyMap<string, SkillMonitorUserProfile>;
  windowDays: SkillMonitorWindowDays;
}): SkillMonitorSummary => {
  const endDay = toUtcPlainDate(now);
  const startDay = endDay.subtract({ days: windowDays - 1 });

  const dayBuckets = new Map<
    string,
    {
      contextReads: number;
      fallbackUses: number;
      runIds: Set<string>;
      users: Set<string>;
    }
  >();

  for (let offset = 0; offset < windowDays; offset += 1) {
    const key = startDay.add({ days: offset }).toString();
    dayBuckets.set(key, {
      contextReads: 0,
      fallbackUses: 0,
      runIds: new Set(),
      users: new Set(),
    });
  }

  const allUsers = new Set<string>();
  const userUsage = new Map<
    string,
    { fallbackUses: number; runIds: Set<string> }
  >();
  const allRunIds = new Set<string>();
  let fallbackUses = 0;
  let chatReads = 0;
  let mcpReads = 0;
  let errorReads = 0;
  let instructionsReads = 0;
  let contextReads = 0;

  const fileStats = new Map<string, { errors: number; reads: number }>();
  for (const path of resourcePaths) {
    fileStats.set(path, { errors: 0, reads: 0 });
  }

  for (const row of rows) {
    const dayKey = toUtcPlainDate(row.createdAt).toString();
    const bucket = dayBuckets.get(dayKey);
    if (!bucket) {
      continue;
    }

    const parsed = parseSkillReadAuditMetadata(row.metadata);
    if (parsed === null) {
      continue;
    }

    const { outcome, path, surface } = parsed;
    let isError: boolean;
    switch (outcome) {
      case SKILL_READ_OUTCOME.error:
        isError = true;
        break;
      case SKILL_READ_OUTCOME.success:
        isError = false;
        break;
      default: {
        outcome satisfies never;
        return panic("Unhandled skill read outcome");
      }
    }

    allUsers.add(row.userId);
    bucket.users.add(row.userId);
    let userEntry = userUsage.get(row.userId);
    if (!userEntry) {
      userEntry = { fallbackUses: 0, runIds: new Set() };
      userUsage.set(row.userId, userEntry);
    }

    if (row.runId !== null && row.runId.length > 0) {
      allRunIds.add(row.runId);
      bucket.runIds.add(row.runId);
      userEntry.runIds.add(row.runId);
    } else if (path === null) {
      fallbackUses += 1;
      bucket.fallbackUses += 1;
      userEntry.fallbackUses += 1;
    }

    switch (surface) {
      case SKILL_READ_SURFACE.mcp:
        mcpReads += 1;
        break;
      case SKILL_READ_SURFACE.chat:
        chatReads += 1;
        break;
      default: {
        surface satisfies never;
        return panic("Unhandled skill read surface");
      }
    }

    if (isError) {
      errorReads += 1;
    }

    if (path === null) {
      instructionsReads += 1;
    } else {
      contextReads += 1;
      bucket.contextReads += 1;
      const existing = fileStats.get(path) ?? { errors: 0, reads: 0 };
      existing.reads += 1;
      if (isError) {
        existing.errors += 1;
      }
      fileStats.set(path, existing);
    }
  }

  const dailyTrend: SkillMonitorDailyPoint[] = [];
  let sumDailyUsers = 0;
  for (const [date, bucket] of dayBuckets) {
    const users = bucket.users.size;
    sumDailyUsers += users;
    dailyTrend.push({
      contextReads: bucket.contextReads,
      date,
      users,
      uses: bucket.runIds.size + bucket.fallbackUses,
    });
  }

  const contextFiles: SkillMonitorContextFileStat[] = [...fileStats.entries()]
    .map(([path, stat]) => ({
      errors: stat.errors,
      path,
      reads: stat.reads,
    }))
    .toSorted((a, b) => b.reads - a.reads || compareKeys(a.path, b.path));

  const activeUsers: SkillMonitorActiveUser[] = [...userUsage.entries()]
    .map(([id, entry]) => {
      const profile = userProfiles?.get(id);
      return {
        id,
        image: profile?.image ?? null,
        name: profile?.name ?? null,
        uses: Math.max(1, entry.runIds.size + entry.fallbackUses),
      };
    })
    .toSorted(
      (a, b) => b.uses - a.uses || compareKeys(a.name ?? a.id, b.name ?? b.id),
    )
    .slice(0, ACTIVE_USERS_MAX);

  const totalUses = allRunIds.size + fallbackUses;
  const totalReads = instructionsReads + contextReads;

  return {
    activeUsers,
    avgDailyActiveUsers: Math.round((sumDailyUsers / windowDays) * 100) / 100,
    chatReads,
    contextFiles,
    contextReads,
    dailyTrend,
    errorReads,
    instructionsReads,
    mcpReads,
    totalReads,
    totalUses,
    truncated,
    uniqueUsers: allUsers.size,
    windowDays,
    windowEnd: endDay.toString(),
    windowStart: startDay.toString(),
  };
};
