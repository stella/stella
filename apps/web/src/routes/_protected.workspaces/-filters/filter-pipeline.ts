import type {
  DateFilter,
  LeadFilter,
  MattersFilters,
  NumericFilter,
  Workspace,
} from "@/routes/_protected.workspaces/-types";

const DAY_MS = 86_400_000;

/** Resolve a DateFilter to a closed-open `[from, to)` epoch range. */
const resolveDateRange = (
  filter: DateFilter,
  now: Date = new Date(),
): { fromMs: number; toMs: number } | null => {
  const startOfDay = (d: Date) => {
    const clone = new Date(d);
    clone.setHours(0, 0, 0, 0);
    return clone.getTime();
  };
  const todayStart = startOfDay(now);

  switch (filter.preset) {
    case "today":
      return { fromMs: todayStart, toMs: todayStart + DAY_MS };
    case "last7d":
      return { fromMs: todayStart - 6 * DAY_MS, toMs: todayStart + DAY_MS };
    case "last30d":
      return { fromMs: todayStart - 29 * DAY_MS, toMs: todayStart + DAY_MS };
    case "thisWeek": {
      // Monday-start week (ISO).
      const day = now.getDay(); // 0=Sun..6=Sat
      const sinceMonday = (day + 6) % 7;
      return {
        fromMs: todayStart - sinceMonday * DAY_MS,
        toMs: todayStart + (7 - sinceMonday) * DAY_MS,
      };
    }
    case "thisMonth": {
      const monthStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        1,
      ).getTime();
      const monthEnd = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        1,
      ).getTime();
      return { fromMs: monthStart, toMs: monthEnd };
    }
    case "custom": {
      if (!filter.from && !filter.to) {
        return null;
      }
      // `from`/`to` are `YYYY-MM-DD` local-date strings (inclusive).
      const fromMs = filter.from
        ? new Date(`${filter.from}T00:00:00`).getTime()
        : Number.NEGATIVE_INFINITY;
      const toMs = filter.to
        ? new Date(`${filter.to}T00:00:00`).getTime() + DAY_MS
        : Number.POSITIVE_INFINITY;
      return { fromMs, toMs };
    }
  }
};

const passesDateFilter = (
  value: Date | string,
  filter: DateFilter,
  now: Date,
): boolean => {
  const range = resolveDateRange(filter, now);
  if (!range) {
    return true;
  }
  const ts = new Date(value).getTime();
  return ts >= range.fromMs && ts < range.toMs;
};

const passesNumericFilter = (value: number, filter: NumericFilter): boolean => {
  if (filter.gte !== undefined && value < filter.gte) {
    return false;
  }
  if (filter.lte !== undefined && value > filter.lte) {
    return false;
  }
  return true;
};

const passesLeadFilter = (
  workspace: Workspace,
  filter: LeadFilter,
): boolean => {
  switch (filter.type) {
    case "any":
      return workspace.leadUserId !== null;
    case "none":
      return workspace.leadUserId === null;
    case "user":
      return workspace.leadUserId === filter.userId;
  }
};

export const isMattersFiltersActive = (filters: MattersFilters): boolean =>
  Object.values(filters).some((v) => v !== undefined);

export const applyMattersFilters = (
  workspaces: readonly Workspace[],
  filters: MattersFilters,
  now: Date = new Date(),
): Workspace[] => {
  if (!isMattersFiltersActive(filters)) {
    return [...workspaces];
  }
  return workspaces.filter((w) => {
    if (
      filters.lastActivityAt &&
      !passesDateFilter(w.lastActivityAt, filters.lastActivityAt, now)
    ) {
      return false;
    }
    if (
      filters.createdAt &&
      !passesDateFilter(w.createdAt, filters.createdAt, now)
    ) {
      return false;
    }
    if (
      filters.client &&
      filters.client.length > 0 &&
      (!w.client || !filters.client.includes(w.client.id))
    ) {
      return false;
    }
    if (filters.team && filters.team.length > 0) {
      const memberIds = new Set(w.members.map((m) => m.userId));
      if (!filters.team.some((id) => memberIds.has(id))) {
        return false;
      }
    }
    if (filters.lead && !passesLeadFilter(w, filters.lead)) {
      return false;
    }
    if (
      filters.entityCount &&
      !passesNumericFilter(w.entityCount, filters.entityCount)
    ) {
      return false;
    }
    return true;
  });
};
