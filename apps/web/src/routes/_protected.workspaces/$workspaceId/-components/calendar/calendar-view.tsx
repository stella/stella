import { useRef, useState } from "react";

import { toastManager } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
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
  getMonthDays,
  getWeekDays,
  getWeekdayLabels,
  isInternalDateProperty,
  isTaskDateProperty,
  TASK_DATE_IDS,
} from "./calendar-utils";
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

const toAllDayAgendaDateTime = (date: string): string =>
  new Date(`${date}T00:00:00.000Z`).toISOString();

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
      toastManager.add({
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

  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();

  const days =
    mode === "month"
      ? getMonthDays(year, month)
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
    setViewDate((d) => {
      const next = new Date(d);
      if (mode === "year") {
        next.setUTCFullYear(next.getUTCFullYear() - 1);
      } else if (mode === "month") {
        next.setUTCMonth(next.getUTCMonth() - 1);
      } else {
        next.setUTCDate(next.getUTCDate() - 7);
      }
      return next;
    });
  };

  const navigateNext = () => {
    setViewDate((d) => {
      const next = new Date(d);
      if (mode === "year") {
        next.setUTCFullYear(next.getUTCFullYear() + 1);
      } else if (mode === "month") {
        next.setUTCMonth(next.getUTCMonth() + 1);
      } else {
        next.setUTCDate(next.getUTCDate() + 7);
      }
      return next;
    });
  };

  const navigateToday = () => {
    setViewDate(new Date());
  };

  const wheelDirection = useRef(0);
  const flushWheel = useDebouncedCallback(() => {
    if (wheelDirection.current < 0) {
      navigatePrev();
    } else if (wheelDirection.current > 0) {
      navigateNext();
    }
    wheelDirection.current = 0;
  }, 120);
  const handleWheel = (e: React.WheelEvent) => {
    wheelDirection.current += e.deltaY;
    flushWheel();
  };

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
        toastManager.add({
          title: t("workspaces.views.calendar.dueDateTaskOnly"),
          type: "foreground",
        });
      } else {
        toastManager.add({
          title: t("workspaces.views.calendar.noDates"),
          type: "foreground",
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
    <div className="flex h-full min-w-0 flex-col" onWheel={handleWheel}>
      <CalendarHeader
        headerLabel={headerLabel}
        month={month}
        onNavigateNext={navigateNext}
        onNavigatePrev={navigatePrev}
        onNavigateToday={navigateToday}
        onSetViewDate={setViewDate}
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
      ) : (
        <>
          <CalendarWeekHeader weekdayLabels={weekdayLabels} />

          {/* Day grid */}
          <div
            className={cn(
              "grid flex-1",
              mode === "month"
                ? "grid-cols-7 grid-rows-6"
                : "grid-cols-7 grid-rows-1",
            )}
          >
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
