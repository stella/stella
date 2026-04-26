import { useCallback, useMemo, useRef, useState } from "react";

import { useQueries, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@stella/ui/components/tooltip";
import { cn } from "@stella/ui/lib/utils";

import type { SafeId } from "@/lib/safe-id";
import type { WorkspaceEntity } from "@/lib/types";
import type { CalendarDay } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-utils";
import {
  appendToMapArray,
  formatMonthYearLabel,
  getEntityDate,
  getMonthDays,
  getMonthLabels,
  getWeekdayLabels,
  getWeekDays,
  INTERNAL_DATE_IDS,
} from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-utils";
import { CurrentTimeIndicator } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/current-time-indicator";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";

export const Route = createFileRoute("/_protected/calendar/")({
  component: CrossWorkspaceCalendar,
});

type CalendarEntity = {
  entity: WorkspaceEntity;
  workspaceId: SafeId<"workspace">;
  workspaceName: string;
  workspaceColor: string | null;
};

const [DATE_PROPERTY] = INTERNAL_DATE_IDS;

function CrossWorkspaceCalendar() {
  const t = useTranslations();
  const locale = useLocale();
  const weekdayLabels = useMemo(() => getWeekdayLabels(locale), [locale]);
  const [mode, setMode] = useState<"month" | "week">("month");
  const [viewDate, setViewDate] = useState(() => new Date());
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<Set<
    SafeId<"workspace">
  > | null>(null);

  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();

  const days = useMemo(
    () =>
      mode === "month" ? getMonthDays(year, month) : getWeekDays(viewDate),
    [mode, year, month, viewDate],
  );

  const { data: workspacesData } = useSuspenseQuery(workspacesOptions);
  const workspaces = workspacesData.workspaces;
  const workspacesById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );

  const activeWorkspaceIds = useMemo(() => {
    if (selectedWorkspaceIds === null) {
      return workspaces.map((w) => w.id);
    }
    return [...selectedWorkspaceIds];
  }, [workspaces, selectedWorkspaceIds]);

  const { entitiesByDate, isLoading } = useQueries({
    queries: activeWorkspaceIds.map((workspaceId) =>
      entitiesOptions({
        workspaceId,
        filters: [],
        sorts: [],
        page: 1,
      }),
    ),
    combine: (results) => {
      const map = new Map<string, CalendarEntity[]>();

      for (let i = 0; i < activeWorkspaceIds.length; i++) {
        const workspaceId = activeWorkspaceIds[i];
        if (!workspaceId) {
          continue;
        }

        const workspace = workspacesById.get(workspaceId);
        const entities = results[i]?.data?.entities;
        if (!workspace || !entities) {
          continue;
        }

        for (const entity of entities) {
          const date = getEntityDate(entity, DATE_PROPERTY);
          if (!date) {
            continue;
          }

          appendToMapArray(map, date, {
            entity,
            workspaceId,
            workspaceName: workspace.name,
            workspaceColor: workspace.color ?? null,
          });
        }
      }

      return {
        entitiesByDate: map,
        isLoading: results.some((result) => result.isLoading),
      };
    },
  });

  const navigatePrev = useCallback(() => {
    setViewDate((d) => {
      const next = new Date(d);
      if (mode === "month") {
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
      if (mode === "month") {
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

  const toggleWorkspace = (id: SafeId<"workspace">) => {
    setSelectedWorkspaceIds((prev) => {
      const current = prev ?? new Set(workspaces.map((w) => w.id));
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const monthLabel = formatMonthYearLabel(locale, year, month);

  const weekLabel =
    mode === "week" ? `${days[0]?.date} – ${days[6]?.date}` : null;

  const monthPickerMonths = useMemo(
    () => getMonthLabels(locale, year, "short"),
    [locale, year],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-t"
      onWheel={handleWheel}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <CalendarIcon className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">{t("navigation.calendar")}</span>
        <span className="bg-border mx-2 h-4 w-px" />
        <Button onClick={navigateToday} size="sm" variant="outline">
          {t("workspaces.views.calendar.today")}
        </Button>
        <Button onClick={navigatePrev} size="icon-sm" variant="ghost">
          <ChevronLeftIcon />
        </Button>
        <Button onClick={navigateNext} size="icon-sm" variant="ghost">
          <ChevronRightIcon />
        </Button>
        <Popover>
          <PopoverTrigger
            render={
              <button
                className="text-sm font-medium hover:underline"
                type="button"
              />
            }
          >
            {weekLabel ?? monthLabel}
          </PopoverTrigger>
          <PopoverPopup
            className="*:data-[slot=popover-viewport]:p-2!"
            side="bottom"
          >
            <div className="flex items-center justify-between pb-1">
              <Button
                onClick={() =>
                  setViewDate((d) => {
                    const n = new Date(d);
                    n.setUTCFullYear(n.getUTCFullYear() - 1);
                    return n;
                  })
                }
                size="icon-xs"
                variant="ghost"
              >
                <ChevronLeftIcon />
              </Button>
              <span className="text-xs font-medium">{year}</span>
              <Button
                onClick={() =>
                  setViewDate((d) => {
                    const n = new Date(d);
                    n.setUTCFullYear(n.getUTCFullYear() + 1);
                    return n;
                  })
                }
                size="icon-xs"
                variant="ghost"
              >
                <ChevronRightIcon />
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {monthPickerMonths.map((label, i) => (
                <Button
                  data-pressed={i === month ? true : undefined}
                  key={label}
                  onClick={() => setViewDate(new Date(Date.UTC(year, i, 1)))}
                  size="xs"
                  variant={i === month ? "secondary" : "ghost"}
                >
                  {label}
                </Button>
              ))}
            </div>
          </PopoverPopup>
        </Popover>

        <span className="flex-1" />

        {/* Mode toggle */}
        <div className="flex gap-0.5">
          <Button
            onClick={() => setMode("month")}
            size="xs"
            variant={mode === "month" ? "secondary" : "ghost"}
          >
            {t("workspaces.views.calendar.month")}
          </Button>
          <Button
            onClick={() => setMode("week")}
            size="xs"
            variant={mode === "week" ? "secondary" : "ghost"}
          >
            {t("workspaces.views.calendar.week")}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Workspace filter sidebar */}
        <div className="w-48 flex-shrink-0 overflow-y-auto border-e p-2">
          <p className="text-muted-foreground mb-1 px-1 text-xs font-medium">
            {t("common.matters")}
          </p>
          {workspaces.map((ws) => {
            const isActive =
              selectedWorkspaceIds === null || selectedWorkspaceIds.has(ws.id);
            return (
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1",
                  "text-start text-xs",
                  "hover:bg-accent",
                  !isActive && "opacity-40",
                )}
                key={ws.id}
                onClick={() => toggleWorkspace(ws.id)}
                type="button"
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: ws.color
                      ? `var(${ws.color})`
                      : "var(--color-muted-foreground)",
                  }}
                />
                <span className="truncate">{ws.name}</span>
              </button>
            );
          })}
        </div>

        {/* Calendar grid */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Weekday headers */}
          <div className="grid grid-cols-7 border-b">
            {weekdayLabels.map((label, i) => (
              <div
                className={cn(
                  "px-2 py-1 text-center text-xs font-medium",
                  "text-muted-foreground",
                  i >= 5 && "bg-muted/20",
                )}
                key={label}
              >
                {label}
              </div>
            ))}
          </div>

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
              <CrossCalendarDayCell
                day={day}
                entities={entitiesByDate.get(day.date) ?? []}
                key={day.date}
                mode={mode}
              />
            ))}
          </div>

          {isLoading && (
            <div className="text-muted-foreground border-t px-4 py-1 text-xs">
              ...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// -- Day cell --

const MAX_VISIBLE_MONTH = 3;
const MAX_VISIBLE_WEEK = 15;

type CrossCalendarDayCellProps = {
  day: CalendarDay;
  entities: CalendarEntity[];
  mode: "month" | "week";
};

const CrossCalendarDayCell = ({
  day,
  entities,
  mode,
}: CrossCalendarDayCellProps) => {
  const t = useTranslations();
  const maxVisible = mode === "month" ? MAX_VISIBLE_MONTH : MAX_VISIBLE_WEEK;
  const visible = entities.slice(0, maxVisible);
  const overflow = entities.length - maxVisible;
  const [expanded, setExpanded] = useState(false);
  const displayEntities = expanded ? entities : visible;

  const dayNum = Number.parseInt(day.date.slice(8), 10);

  return (
    <div
      className={cn(
        "relative flex flex-col gap-0.5 border-e border-b p-1",
        "overflow-hidden",
        !day.isCurrentMonth && "bg-muted/30",
        day.isWeekend && day.isCurrentMonth && "bg-muted/15",
        mode === "week" && "min-h-[300px]",
      )}
    >
      {mode === "week" && day.isToday && <CurrentTimeIndicator />}

      <div className="flex items-center justify-between">
        <span
          className={cn(
            "inline-flex size-6 items-center justify-center",
            "rounded-full text-xs",
            day.isToday && "bg-primary text-primary-foreground font-medium",
            !day.isCurrentMonth && "text-muted-foreground",
          )}
        >
          {dayNum}
        </span>
      </div>

      <div className="flex flex-col gap-0.5">
        {displayEntities.map((entry) => (
          <CrossCalendarEntityCard entry={entry} key={entry.entity.entityId} />
        ))}
      </div>

      {overflow > 0 && !expanded && (
        <button
          className="text-muted-foreground hover:text-foreground text-start text-xs"
          onClick={() => setExpanded(true)}
          type="button"
        >
          {t("workspaces.views.calendar.more", {
            count: String(overflow),
          })}
        </button>
      )}
    </div>
  );
};

// -- Entity card --

const CrossCalendarEntityCard = ({ entry }: { entry: CalendarEntity }) => {
  const name = getEntityName(entry.entity);
  const openPdf = useInspectorStore((s) => s.openPdf);
  const openTask = useInspectorStore((s) => s.openTask);
  const file = getFirstFile(entry.entity);

  const handleClick = () => {
    if (entry.entity.kind === "task") {
      openTask(entry.entity.entityId, name);
      return;
    }
    if (file) {
      openPdf({
        id: file.fieldId,
        entityId: entry.entity.entityId,
        label: name,
        mimeType: file.mimeType,
        pdfFileId: file.pdfFileId,
        workspaceId: entry.workspaceId,
      });
    }
  };

  const card = (
    <button
      className={cn(
        "bg-card w-full rounded border border-s-2 px-1.5 py-0.5",
        "hover:bg-accent text-start text-xs",
        "truncate",
      )}
      onClick={handleClick}
      style={{
        borderInlineStartColor: entry.workspaceColor
          ? `var(${entry.workspaceColor})`
          : "var(--color-muted-foreground)",
      }}
      type="button"
    >
      {name}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="w-full" />}>
        {card}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5 py-0.5">
          <span className="font-medium">{name}</span>
          <span className="text-muted-foreground">{entry.workspaceName}</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
};
