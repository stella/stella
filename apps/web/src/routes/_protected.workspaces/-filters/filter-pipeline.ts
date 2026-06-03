import type {
  DateFilter,
  LeadFilter,
  MattersFilters,
  NumericFilter,
  Workspace,
} from "@/routes/_protected.workspaces/-types";

export const parseLocalISODateMs = (value: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return Number.NaN;
  }
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).getTime();
};

const addLocalCalendarDaysMs = (value: number, days: number): number => {
  const date = new Date(value);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
  ).getTime();
};

type FilterableWorkspace = {
  client: Pick<NonNullable<Workspace["client"]>, "id"> | null;
  createdAt: Workspace["createdAt"];
  entityCount: number;
  lastActivityAt: Workspace["lastActivityAt"];
  leadUserId: string | null;
  members: readonly { userId: string }[];
};

/** Resolve a DateFilter to a closed-open `[from, to)` epoch range. */
const resolveDateRange = (
  filter: DateFilter,
  now: Date = new Date(),
): { fromMs: number; toMs: number } | null => {
  const startOfDay = (d: Date): number => {
    const clone = new Date(d);
    clone.setHours(0, 0, 0, 0);
    return clone.getTime();
  };
  const todayStart = startOfDay(now);

  switch (filter.preset) {
    case "today":
      return {
        fromMs: todayStart,
        toMs: addLocalCalendarDaysMs(todayStart, 1),
      };
    case "last7d":
      return {
        fromMs: addLocalCalendarDaysMs(todayStart, -6),
        toMs: addLocalCalendarDaysMs(todayStart, 1),
      };
    case "last30d":
      return {
        fromMs: addLocalCalendarDaysMs(todayStart, -29),
        toMs: addLocalCalendarDaysMs(todayStart, 1),
      };
    case "thisWeek": {
      // Monday-start week (ISO).
      const day = now.getDay(); // 0=Sun..6=Sat
      const sinceMonday = (day + 6) % 7;
      return {
        fromMs: addLocalCalendarDaysMs(todayStart, -sinceMonday),
        toMs: addLocalCalendarDaysMs(todayStart, 7 - sinceMonday),
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
        ? parseLocalISODateMs(filter.from)
        : Number.NEGATIVE_INFINITY;
      const toMs = filter.to
        ? addLocalCalendarDaysMs(parseLocalISODateMs(filter.to), 1)
        : Number.POSITIVE_INFINITY;
      return { fromMs, toMs };
    }
  }
  filter.preset satisfies never;
  return null;
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
  workspace: Pick<FilterableWorkspace, "leadUserId">,
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
  filter satisfies never;
  return false;
};

export const isMattersFiltersActive = (filters: MattersFilters): boolean =>
  filters.lastActivityAt !== undefined ||
  filters.createdAt !== undefined ||
  filters.client !== undefined ||
  filters.team !== undefined ||
  filters.lead !== undefined ||
  filters.entityCount !== undefined;

export const applyMattersFilters = <TWorkspace extends FilterableWorkspace>(
  workspaces: readonly TWorkspace[],
  filters: MattersFilters,
  now: Date = new Date(),
): TWorkspace[] => {
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
