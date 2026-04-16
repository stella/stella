import { useCallback, useMemo, useRef, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { CalendarIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useLocale, useTranslations } from "use-intl";

import { toastManager } from "@stella/ui/components/toast";
import { cn } from "@stella/ui/lib/utils";

import { api } from "@/lib/api";
import type { EntityKind, WorkspaceView } from "@/lib/types";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  useCreateEntities,
  useUpsertField,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import {
  entitiesKeys,
  useEntitiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

import { CalendarDayCell } from "./calendar-day-cell";
import type { CalendarEntry } from "./calendar-day-cell";
import {
  KIND_DOT_COLORS,
  TASK_STATUS_DOT_COLORS,
} from "./calendar-entity-chip";
import { CalendarHeader } from "./calendar-header";
import {
  appendToMapArray,
  formatMonthYearLabel,
  getEntityDate,
  getMonthDays,
  getWeekDays,
  getWeekdayLabels,
  isInternalDateProperty,
  isTaskDateProperty,
  TASK_DATE_IDS,
} from "./calendar-utils";
import { CalendarWeekHeader } from "./calendar-week-header";
import type { YearDot } from "./calendar-year-grid";
import { CalendarYearGrid } from "./calendar-year-grid";

type CalendarViewProps = {
  view: WorkspaceView<"calendar">;
  workspaceId: string;
};

export const CalendarView = ({ view, workspaceId }: CalendarViewProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const weekdayLabels = useMemo(() => getWeekdayLabels(locale), [locale]);
  const { filters, sorts } = view.layout;
  const { datePropertyId, endDatePropertyId, additionalDatePropertyIds, mode } =
    view.layout;
  const upsertField = useUpsertField();
  const createEntities = useCreateEntities();

  const isEditable =
    !!datePropertyId && !isInternalDateProperty(datePropertyId);

  const handleCreate = useCallback(
    async (date: string, kind: EntityKind) => {
      if (!isEditable) {
        return;
      }

      if (kind === "task") {
        // Use the dedicated tasks endpoint so status/priority
        // are set correctly (the generic createEntities handler
        // does not set task defaults).
        const dueDate = datePropertyId === "_due-date" ? date : undefined;
        const response = await api.tasks({ workspaceId }).put({
          queryKey: entitiesKeys.all(workspaceId),
          name: t("tasks.untitled"),
          ...(dueDate && { dueDate }),
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
        if (
          !isTaskDateProperty(datePropertyId) &&
          datePropertyId !== "_due-date"
        ) {
          upsertField.mutate({
            workspaceId,
            propertyId: datePropertyId,
            entityId,
            content: {
              type: "date",
              version: 1,
              value: date,
            },
          });
        }

        useInspectorStore.getState().openTask(entityId, "", true);
        return;
      }

      // Non-task entities use the generic creation handler
      createEntities.mutate(
        {
          type: "manual-input",
          workspaceId,
          kind,
        },
        {
          onSuccess: (data) => {
            if (!data.entityId) {
              return;
            }
            if (!isTaskDateProperty(datePropertyId)) {
              upsertField.mutate({
                workspaceId,
                propertyId: datePropertyId,
                entityId: data.entityId,
                content: {
                  type: "date",
                  version: 1,
                  value: date,
                },
              });
            }
          },
        },
      );
    },
    [isEditable, createEntities, workspaceId, datePropertyId, upsertField, t],
  );

  // Current viewport date (month/week navigation state)
  const [viewDate, setViewDate] = useState(() => new Date());

  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();

  const days = useMemo(
    () =>
      mode === "month"
        ? getMonthDays(year, month)
        : mode === "week"
          ? getWeekDays(viewDate)
          : [],
    [mode, year, month, viewDate],
  );

  // Fetch all entities (calendar doesn't paginate; uses
  // filters from the view)
  const { data: entityData } = useSuspenseQuery(
    useEntitiesOptions({
      workspaceId,
      filters,
      sorts,
      page: 1,
    }),
  );

  // All date property IDs to show on the calendar
  const allDatePropertyIds = useMemo(() => {
    const ids = [datePropertyId];
    if (additionalDatePropertyIds) {
      for (const id of additionalDatePropertyIds) {
        if (!ids.includes(id)) {
          ids.push(id);
        }
      }
    }
    return ids;
  }, [datePropertyId, additionalDatePropertyIds]);

  // Group entities by date across all configured date properties
  const entitiesByDate = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();

    for (const entity of entityData.entities) {
      for (const propId of allDatePropertyIds) {
        const startDate = getEntityDate(entity, propId);
        if (!startDate) {
          continue;
        }

        // Only apply end-date spanning for the primary
        // date property (multi-day range)
        const endDate =
          propId === datePropertyId && endDatePropertyId
            ? getEntityDate(entity, endDatePropertyId)
            : null;

        if (endDate && endDate > startDate) {
          const current = new Date(`${startDate}T00:00:00Z`);
          const end = new Date(`${endDate}T00:00:00Z`);
          while (current <= end) {
            const iso = current.toISOString().slice(0, 10);
            appendToMapArray(map, iso, { entity, propertyId: propId });
            current.setUTCDate(current.getUTCDate() + 1);
          }
        } else {
          appendToMapArray(map, startDate, { entity, propertyId: propId });
        }
      }
    }

    return map;
  }, [
    entityData.entities,
    allDatePropertyIds,
    datePropertyId,
    endDatePropertyId,
  ]);

  const navigatePrev = useCallback(() => {
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
  }, [mode]);

  const navigateNext = useCallback(() => {
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
  }, [mode]);

  const navigateToday = useCallback(() => {
    setViewDate(new Date());
  }, []);

  const wheelDirection = useRef(0);
  const flushWheel = useDebouncedCallback(() => {
    if (wheelDirection.current < 0) {
      navigatePrev();
    } else if (wheelDirection.current > 0) {
      navigateNext();
    }
    wheelDirection.current = 0;
  }, 120);
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      wheelDirection.current += e.deltaY;
      flushWheel();
    },
    [flushWheel],
  );

  const handleDrop = useCallback(
    (date: string, entityId: string, kind: string) => {
      if (!isEditable) {
        return;
      }
      if (datePropertyId === TASK_DATE_IDS[0] && kind === "task") {
        api
          .tasks({ workspaceId })
          .patch({
            taskId: entityId,
            queryKey: entitiesKeys.all(workspaceId),
            dueDate: date,
          })
          .catch(() => {
            // non-critical
          });
      } else if (isTaskDateProperty(datePropertyId)) {
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
        upsertField.mutate({
          workspaceId,
          propertyId: datePropertyId,
          entityId,
          content: {
            type: "date",
            version: 1,
            value: date,
          },
        });
      }
    },
    [isEditable, datePropertyId, workspaceId, upsertField, t],
  );

  // Build dots for year view
  const yearDots = useMemo<YearDot[]>(() => {
    if (mode !== "year") {
      return [];
    }
    const dots: YearDot[] = [];
    for (const [date, entries] of entitiesByDate) {
      for (const { entity } of entries) {
        dots.push({
          date,
          color:
            entity.kind === "task" && entity.status
              ? (TASK_STATUS_DOT_COLORS[entity.status] ?? "#a3a3a3")
              : (KIND_DOT_COLORS[entity.kind] ??
                KIND_DOT_COLORS.document ??
                "#a3a3a3"),
        });
      }
    }
    return dots;
  }, [mode, entitiesByDate]);

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
                workspaceId={workspaceId}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};
