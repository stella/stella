import { useLayoutEffect, useRef, useState } from "react";
import type { UIEvent } from "react";

import { stellaToast } from "@stll/ui/components/toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarIcon } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { api } from "@/lib/api";
import { toSafeId } from "@/lib/safe-id";
import type { EntityKind, WorkspaceView } from "@/lib/types";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useUpsertField } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import {
  calendarTasksKeys,
  calendarTasksOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/calendar-tasks";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

import { CalendarDayCell } from "./calendar-day-cell";
import { TASK_STATUS_DOT_COLORS } from "./calendar-entity-chip";
import { CalendarHeader } from "./calendar-header";
import {
  formatMonthYearLabel,
  getWeekDays,
  getWeekdayLabels,
  isInternalDateProperty,
  isTaskDateProperty,
  TASK_DATE_IDS,
} from "./calendar-utils";
import type { CalendarDay } from "./calendar-utils";
import {
  getCalendarVisibleRange,
  groupCalendarTasksByDate,
} from "./calendar-view.logic";
import { CalendarWeekHeader } from "./calendar-week-header";
import type { YearDot } from "./calendar-year-grid";
import { CalendarYearGrid } from "./calendar-year-grid";

type CalendarViewProps = {
  view: WorkspaceView<"calendar">;
  workspaceId: string;
};

type MonthAnchor = {
  column: number;
  key: string;
  label: string;
  month: number;
  year: number;
};

type CalendarWeekRow = {
  key: string;
  anchors: MonthAnchor[];
  days: CalendarDay[];
};

const MONTH_WINDOW_SIZE = 9;
const MONTH_WINDOW_SHIFT = 3;
const MONTH_WINDOW_CENTER = Math.floor(MONTH_WINDOW_SIZE / 2);

const toAllDayAgendaDateTime = (date: string): string =>
  new Date(`${date}T00:00:00.000Z`).toISOString();

const startOfUTCMonth = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

const addUTCMonths = (date: Date, amount: number): Date => {
  const next = startOfUTCMonth(date);
  next.setUTCMonth(next.getUTCMonth() + amount);
  return next;
};

const getUTCMonthKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

const getMonthDistance = (from: Date, to: Date): number =>
  (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
  (to.getUTCMonth() - from.getUTCMonth());

const toUTCDateKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const startOfUTCWeek = (date: Date): Date => {
  const start = new Date(date);
  const dayOfWeek = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - dayOfWeek);
  return start;
};

const addUTCDays = (date: Date, amount: number): Date => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
};

const getContinuousWeekDays = (weekStart: Date): CalendarDay[] => {
  const today = toUTCDateKey(new Date());

  return Array.from({ length: 7 }, (_, index) => {
    const date = addUTCDays(weekStart, index);
    const key = toUTCDateKey(date);
    const month = date.getUTCMonth();
    const startsMonth = date.getUTCDate() === 1;
    const monthTone = month % 2 === 0 ? "muted" : null;

    return {
      date: key,
      isCurrentMonth: true,
      isToday: key === today,
      ...(startsMonth && { startsMonth }),
      ...(monthTone && { monthTone }),
      isWeekend: index >= 5,
    };
  });
};

const getMonthAnchors = (locale: string, windowStart: Date): MonthAnchor[] =>
  Array.from({ length: MONTH_WINDOW_SIZE }, (_, index) => {
    const date = addUTCMonths(windowStart, index);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();

    return {
      column: (date.getUTCDay() + 6) % 7,
      key: getUTCMonthKey(date),
      label: formatMonthYearLabel(locale, year, month),
      month,
      year,
    };
  });

const getMonthWeekRows = (
  locale: string,
  windowStart: Date,
): CalendarWeekRow[] => {
  const anchors = getMonthAnchors(locale, windowStart);
  const anchorsByWeek = new Map<string, MonthAnchor[]>();

  for (const anchor of anchors) {
    const anchorDate = new Date(Date.UTC(anchor.year, anchor.month, 1));
    const weekKey = toUTCDateKey(startOfUTCWeek(anchorDate));
    const bucket = anchorsByWeek.get(weekKey);
    if (bucket) {
      bucket.push(anchor);
      continue;
    }

    anchorsByWeek.set(weekKey, [anchor]);
  }

  const rows: CalendarWeekRow[] = [];
  const firstWeekStart = startOfUTCWeek(windowStart);
  const lastMonth = addUTCMonths(windowStart, MONTH_WINDOW_SIZE - 1);
  const lastWeekStart = startOfUTCWeek(
    new Date(
      Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 0),
    ),
  );

  for (
    let weekStart = firstWeekStart;
    weekStart <= lastWeekStart;
    weekStart = addUTCDays(weekStart, 7)
  ) {
    const key = toUTCDateKey(weekStart);
    rows.push({
      key,
      anchors: anchorsByWeek.get(key) ?? [],
      days: getContinuousWeekDays(weekStart),
    });
  }

  return rows;
};

export const CalendarView = ({ view, workspaceId }: CalendarViewProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const weekdayLabels = getWeekdayLabels(locale);
  const { filters, sorts } = view.layout;
  const { datePropertyId, endDatePropertyId, additionalDatePropertyIds, mode } =
    view.layout;
  const upsertField = useUpsertField();
  const invalidateCalendarTasks = async () => {
    await queryClient.invalidateQueries({
      queryKey: calendarTasksKeys.all(workspaceId),
    });
  };

  const isEditable =
    !!datePropertyId && !isInternalDateProperty(datePropertyId);

  const handleCreate = async (date: string, kind: EntityKind) => {
    if (!isEditable || kind !== "task") {
      return;
    }

    // Use the dedicated tasks endpoint so status/priority
    // are set correctly (the generic createEntities handler
    // does not set task defaults).
    const dueDate = datePropertyId === TASK_DATE_IDS[0] ? date : undefined;
    const startAt =
      datePropertyId === TASK_DATE_IDS[1]
        ? toAllDayAgendaDateTime(date)
        : undefined;
    const response = await api.tasks({ workspaceId }).put({
      queryKey: entitiesKeys.all(workspaceId),
      name: t("tasks.untitled"),
      ...(dueDate && { dueDate }),
      ...(startAt && { allDay: true, startAt }),
    });

    const entityId = response.data?.entityId;
    if (response.error || !entityId) {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    // Set custom date property if not using built-in due date
    if (!isTaskDateProperty(datePropertyId)) {
      upsertField.mutate(
        {
          workspaceId,
          propertyId: datePropertyId,
          entityId,
          content: {
            type: "date",
            version: 1,
            value: date,
          },
        },
        {
          onSuccess: () => {
            void invalidateCalendarTasks();
          },
        },
      );
    } else {
      await invalidateCalendarTasks();
    }

    useInspectorStore.getState().openTask(entityId, "", true);
  };

  // Current viewport date (month/week navigation state)
  const [viewDate, setViewDate] = useState(() => new Date());
  const [monthWindowStart, setMonthWindowStart] = useState(() =>
    addUTCMonths(new Date(), -MONTH_WINDOW_CENTER),
  );
  const monthScrollRef = useRef<HTMLDivElement>(null);
  const monthAnchorRefs = useRef(new Map<string, HTMLElement>());
  const latestViewDate = useRef(viewDate);
  const pendingScrollMonthKey = useRef<string | null>(null);
  const pendingScrollAdjustment = useRef<{
    key: string;
    top: number;
  } | null>(null);
  const isShiftingMonthWindow = useRef(false);

  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();
  latestViewDate.current = viewDate;
  const monthWeeks = getMonthWeekRows(locale, monthWindowStart);
  const monthAnchors = getMonthAnchors(locale, monthWindowStart);

  const days =
    mode === "month"
      ? monthWeeks.flatMap((week) => week.days)
      : mode === "week"
        ? getWeekDays(viewDate)
        : [];

  // All date property IDs to show on the calendar
  const allDatePropertyIds = [datePropertyId];
  if (additionalDatePropertyIds) {
    for (const id of additionalDatePropertyIds) {
      if (!allDatePropertyIds.includes(id)) {
        allDatePropertyIds.push(id);
      }
    }
  }

  const visibleRange = getCalendarVisibleRange({ days, mode, month, year });

  const { data: calendarTasks = [] } = useQuery({
    ...calendarTasksOptions({
      workspaceId,
      filters,
      sorts,
      dateFrom: visibleRange.dateFrom,
      dateTo: visibleRange.dateTo,
      datePropertyIds: allDatePropertyIds,
      endDatePropertyId,
    }),
    throwOnError: true,
  });

  // Group tasks by date across all configured date properties
  const entitiesByDate = groupCalendarTasksByDate({
    tasks: calendarTasks,
    datePropertyIds: allDatePropertyIds,
    datePropertyId,
    endDatePropertyId,
  });

  const navigatePrev = () => {
    if (mode === "month") {
      scrollToMonth(addUTCMonths(viewDate, -1));
      return;
    }

    setViewDate((d) => {
      const next = new Date(d);
      if (mode === "year") {
        next.setUTCFullYear(next.getUTCFullYear() - 1);
      } else {
        next.setUTCDate(next.getUTCDate() - 7);
      }
      return next;
    });
  };

  const navigateNext = () => {
    if (mode === "month") {
      scrollToMonth(addUTCMonths(viewDate, 1));
      return;
    }

    setViewDate((d) => {
      const next = new Date(d);
      if (mode === "year") {
        next.setUTCFullYear(next.getUTCFullYear() + 1);
      } else {
        next.setUTCDate(next.getUTCDate() + 7);
      }
      return next;
    });
  };

  const navigateToday = () => {
    const today = new Date();
    if (mode === "month") {
      scrollToMonth(today);
      return;
    }

    setViewDate(today);
  };

  const getVisibleMonthAnchor = () => {
    const container = monthScrollRef.current;
    if (!container) {
      return null;
    }

    const markerY = container.getBoundingClientRect().top + 48;
    let visible: { key: string; anchor: MonthAnchor; top: number } | null =
      null;

    for (const anchor of monthAnchors) {
      const element = monthAnchorRefs.current.get(anchor.key);
      if (!element) {
        continue;
      }

      const top = element.getBoundingClientRect().top;
      if (top > markerY) {
        return visible ?? { key: anchor.key, anchor, top };
      }

      visible = { key: anchor.key, anchor, top };
    }

    return visible;
  };

  const updateVisibleMonth = () => {
    const anchor = getVisibleMonthAnchor();
    if (!anchor) {
      return;
    }

    if (anchor.anchor.year === year && anchor.anchor.month === month) {
      return;
    }

    setViewDate(new Date(Date.UTC(anchor.anchor.year, anchor.anchor.month, 1)));
  };

  const shiftMonthWindow = (amount: number) => {
    if (isShiftingMonthWindow.current) {
      return;
    }

    const anchor = getVisibleMonthAnchor();
    if (anchor) {
      pendingScrollAdjustment.current = {
        key: anchor.key,
        top: anchor.top,
      };
    }

    isShiftingMonthWindow.current = true;
    setMonthWindowStart((start) => addUTCMonths(start, amount));
  };

  const handleMonthScroll = (event: UIEvent<HTMLDivElement>) => {
    updateVisibleMonth();

    const { clientHeight, scrollHeight, scrollTop } = event.currentTarget;
    if (scrollTop < clientHeight) {
      shiftMonthWindow(-MONTH_WINDOW_SHIFT);
      return;
    }

    if (scrollHeight - scrollTop - clientHeight < clientHeight) {
      shiftMonthWindow(MONTH_WINDOW_SHIFT);
    }
  };

  const scrollToMonth = (date: Date) => {
    const target = startOfUTCMonth(date);
    const targetKey = getUTCMonthKey(target);
    pendingScrollMonthKey.current = targetKey;
    setViewDate(target);

    setMonthWindowStart((start) => {
      const distance = getMonthDistance(start, target);
      if (distance >= 0 && distance < MONTH_WINDOW_SIZE) {
        return start;
      }

      return addUTCMonths(target, -MONTH_WINDOW_CENTER);
    });

    const element = monthAnchorRefs.current.get(targetKey);
    if (element) {
      element.scrollIntoView({ block: "start" });
      pendingScrollMonthKey.current = null;
    }
  };

  useLayoutEffect(() => {
    if (mode !== "month") {
      return;
    }

    const key = getUTCMonthKey(startOfUTCMonth(latestViewDate.current));
    pendingScrollMonthKey.current = key;
  }, [mode]);

  useLayoutEffect(() => {
    const container = monthScrollRef.current;
    if (!container) {
      return;
    }

    const adjustment = pendingScrollAdjustment.current;
    if (adjustment) {
      const element = monthAnchorRefs.current.get(adjustment.key);
      if (element) {
        container.scrollTop +=
          element.getBoundingClientRect().top - adjustment.top;
      }
      pendingScrollAdjustment.current = null;
      isShiftingMonthWindow.current = false;
    }

    const scrollKey = pendingScrollMonthKey.current;
    if (!scrollKey) {
      return;
    }

    const element = monthAnchorRefs.current.get(scrollKey);
    if (!element) {
      return;
    }

    element.scrollIntoView({ block: "start" });
    pendingScrollMonthKey.current = null;
  }, [mode, monthWindowStart, viewDate]);

  const handleDrop = (date: string, entityId: string, kind: string) => {
    if (!isEditable) {
      return;
    }
    if (datePropertyId === TASK_DATE_IDS[0] && kind === "task") {
      api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .patch({
          taskId: toSafeId<"entity">(entityId),
          queryKey: entitiesKeys.all(workspaceId),
          dueDate: date,
        })
        .then(() => {
          void invalidateCalendarTasks();
        })
        .catch(() => {
          // non-critical
        });
    } else if (datePropertyId === TASK_DATE_IDS[1] && kind === "task") {
      api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .patch({
          taskId: toSafeId<"entity">(entityId),
          queryKey: entitiesKeys.all(workspaceId),
          allDay: true,
          startAt: toAllDayAgendaDateTime(date),
        })
        .then(() => {
          void invalidateCalendarTasks();
        })
        .catch(() => {
          // non-critical
        });
    } else if (isTaskDateProperty(datePropertyId)) {
      // Future-proofing for any new built-in task date pseudo-property.
      if (kind !== "task") {
        stellaToast.add({
          title: t("workspaces.views.calendar.dueDateTaskOnly"),
          type: "neutral",
        });
      } else {
        stellaToast.add({
          title: t("workspaces.views.calendar.noDates"),
          type: "neutral",
        });
      }
    } else {
      upsertField.mutate(
        {
          workspaceId,
          propertyId: datePropertyId,
          entityId,
          content: {
            type: "date",
            version: 1,
            value: date,
          },
        },
        {
          onSuccess: () => {
            void invalidateCalendarTasks();
          },
        },
      );
    }
  };

  // Build dots for year view
  const yearDots: YearDot[] = [];
  if (mode === "year") {
    for (const [date, entries] of entitiesByDate) {
      for (const { entity } of entries) {
        yearDots.push({
          date,
          color: entity.status
            ? (TASK_STATUS_DOT_COLORS[entity.status] ?? "var(--option-gray)")
            : "var(--option-gray)",
        });
      }
    }
  }

  if (!datePropertyId) {
    return (
      <EmptyState
        hint={t("workspaces.views.calendar.noDates")}
        icon={CalendarIcon}
        message={t("workspaces.views.calendar.showBy")}
      />
    );
  }

  const monthLabel = formatMonthYearLabel(locale, year, month);

  const headerLabel =
    mode === "year"
      ? String(year)
      : mode === "week"
        ? `${days[0]?.date} – ${days[6]?.date}`
        : monthLabel;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <CalendarHeader
        headerLabel={headerLabel}
        month={month}
        onNavigateNext={navigateNext}
        onNavigatePrev={navigatePrev}
        onNavigateToday={navigateToday}
        onSetViewDate={(date) => {
          if (mode === "month") {
            scrollToMonth(date);
            return;
          }

          setViewDate(date);
        }}
        year={year}
      />

      {mode === "year" ? (
        <CalendarYearGrid
          dots={yearDots}
          onMonthClick={(m) => {
            setViewDate(new Date(Date.UTC(year, m, 1)));
            // Year grid doesn't set mode; the mode is controlled
            // by the view layout. Clicking a month navigates but
            // stays in year view.
          }}
          year={year}
        />
      ) : mode === "month" ? (
        <>
          <CalendarWeekHeader weekdayLabels={weekdayLabels} />

          <div
            className="relative flex-1 overflow-y-auto overscroll-contain"
            onScroll={handleMonthScroll}
            ref={monthScrollRef}
          >
            <div className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-20 border-b px-4 py-1.5 backdrop-blur">
              <button
                className="text-muted-foreground hover:text-foreground rounded text-xs font-medium transition-colors"
                onClick={() => scrollToMonth(viewDate)}
                type="button"
              >
                {monthLabel}
              </button>
            </div>

            {monthWeeks.map((week) => (
              <div className="contents" key={week.key}>
                {week.anchors.map((anchor) => (
                  <div
                    className="bg-background/70 grid h-6 scroll-mt-7 grid-cols-7 border-b"
                    key={anchor.key}
                    ref={(element) => {
                      if (element) {
                        monthAnchorRefs.current.set(anchor.key, element);
                        return;
                      }

                      monthAnchorRefs.current.delete(anchor.key);
                    }}
                  >
                    <div
                      className="border-s-foreground/35 text-muted-foreground after:bg-foreground/35 relative flex items-center border-s-2 px-2 text-xs font-medium after:absolute after:-start-0.5 after:-bottom-px after:h-px after:w-0.5"
                      style={{ gridColumn: `${anchor.column + 1} / 8` }}
                    >
                      {anchor.label}
                    </div>
                  </div>
                ))}
                <div className="grid min-h-[calc((100%_-_1.75rem)/6)] grid-cols-7">
                  {week.days.map((day) => (
                    <CalendarDayCell
                      day={day}
                      entries={entitiesByDate.get(day.date) ?? []}
                      isEditable={isEditable}
                      key={day.date}
                      mode="month"
                      onCreate={(kind) => {
                        handleCreate(day.date, kind).catch(() => {
                          // Error handled inside handleCreate
                        });
                      }}
                      onDrop={(entityId, kind) =>
                        handleDrop(day.date, entityId, kind)
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <CalendarWeekHeader weekdayLabels={weekdayLabels} />

          <div className="grid flex-1 grid-cols-7 grid-rows-1">
            {days.map((day) => (
              <CalendarDayCell
                day={day}
                entries={entitiesByDate.get(day.date) ?? []}
                isEditable={isEditable}
                key={day.date}
                mode={mode}
                onCreate={(kind) => {
                  handleCreate(day.date, kind).catch(() => {
                    // Error handled inside handleCreate
                  });
                }}
                onDrop={(entityId, kind) =>
                  handleDrop(day.date, entityId, kind)
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};
