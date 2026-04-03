import { useMemo, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
} from "@stella/ui/components/select";
import { cn } from "@stella/ui/lib/utils";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import {
  getMonthDays,
  getWeekdayLabels,
} from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-utils";
import {
  PRIORITY_COLORS,
  PRIORITY_ICONS,
  STATUS_COLORS,
  STATUS_ICONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  toISODate,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { taskKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/tasks";
import { workspaceMembersOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";

import type { TaskPriority, TaskStatus } from "./task-detail-constants";

// -- Layout helper --

export const MetadataRow = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="flex items-center gap-3">
    <span className="text-muted-foreground w-24 shrink-0 text-xs">{label}</span>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

// -- Icon helpers --

const StatusIcon = ({ status }: { status: TaskStatus }) => {
  const Icon = STATUS_ICONS[status];
  return <Icon className={cn("size-3.5", STATUS_COLORS[status])} />;
};

const PriorityIcon = ({ priority }: { priority: TaskPriority }) => {
  const Icon = PRIORITY_ICONS[priority];
  return <Icon className={cn("size-3.5", PRIORITY_COLORS[priority])} />;
};

// -- Status select --

type StatusSelectProps = {
  value: TaskStatus;
  onChange: (value: TaskStatus | null) => void;
};

export const StatusSelect = ({ value, onChange }: StatusSelectProps) => {
  const t = useTranslations("tasks");
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger
        className="h-7 min-h-7 min-w-0 gap-1 border-none bg-transparent px-1.5 shadow-none"
        size="sm"
      >
        <StatusIcon status={value} />
        <span className="truncate">{t(`statusValues.${value}`)}</span>
      </SelectTrigger>
      <SelectPopup>
        {TASK_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            <span className="flex items-center gap-2">
              <StatusIcon status={s} />
              {t(`statusValues.${s}`)}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

// -- Priority select --

type PrioritySelectProps = {
  value: TaskPriority;
  onChange: (value: TaskPriority | null) => void;
};

export const PrioritySelect = ({ value, onChange }: PrioritySelectProps) => {
  const t = useTranslations("tasks");
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger
        className="h-7 min-h-7 min-w-0 gap-1 border-none bg-transparent px-1.5 shadow-none"
        size="sm"
      >
        <PriorityIcon priority={value} />
        <span className="truncate">{t(`priorityValues.${value}`)}</span>
      </SelectTrigger>
      <SelectPopup>
        {TASK_PRIORITIES.map((p) => (
          <SelectItem key={p} value={p}>
            <span className="flex items-center gap-2">
              <PriorityIcon priority={p} />
              {t(`priorityValues.${p}`)}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

// -- Date picker --

type DatePickerPopoverProps = {
  value: string | Date | null;
  onChange: (value: string | null) => void;
  isOverdue?: boolean;
};

export const DatePickerPopover = ({
  value: rawValue,
  onChange,
  isOverdue = false,
}: DatePickerPopoverProps) => {
  const t = useTranslations("tasks");
  const locale = useLocale();

  const value = toISODate(rawValue);
  const [viewYear, setViewYear] = useState(() => {
    const d = value ? new Date(`${value}T00:00:00Z`) : new Date();
    return d.getUTCFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    const d = value ? new Date(`${value}T00:00:00Z`) : new Date();
    return d.getUTCMonth();
  });

  const days = useMemo(
    () => getMonthDays(viewYear, viewMonth),
    [viewYear, viewMonth],
  );
  const weekdays = useMemo(() => getWeekdayLabels(locale), [locale]);

  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(viewYear, viewMonth, 1)));

  const navigatePrev = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const navigateNext = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const displayLabel = value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "\u2014";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            className={cn(
              "flex h-7 w-full items-center gap-1.5",
              "rounded-md px-1.5 text-sm",
              "hover:bg-muted transition-colors",
              isOverdue
                ? "text-red-500"
                : value
                  ? "text-foreground"
                  : "text-muted-foreground",
            )}
            type="button"
          />
        }
      >
        <CalendarIcon className="size-3.5 shrink-0" />
        <span>{displayLabel}</span>
        {isOverdue && (
          <span className="text-xs text-red-500">{t("overdue")}</span>
        )}
      </PopoverTrigger>
      <PopoverPopup
        className="*:data-[slot=popover-viewport]:p-2!"
        side="bottom"
      >
        <div className="w-56">
          {/* Month/year nav */}
          <div className="flex items-center justify-between pb-1">
            <Button onClick={navigatePrev} size="icon-xs" variant="ghost">
              <ChevronLeftIcon />
            </Button>
            <span className="text-xs font-medium">{monthLabel}</span>
            <Button onClick={navigateNext} size="icon-xs" variant="ghost">
              <ChevronRightIcon />
            </Button>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 gap-0">
            {weekdays.map((wd) => (
              <span
                className="text-muted-foreground py-1 text-center text-[10px]"
                key={wd}
              >
                {wd}
              </span>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0">
            {days.map((day) => {
              const isSelected = day.date === value;
              return (
                <button
                  className={cn(
                    "flex size-8 items-center justify-center",
                    "rounded-full text-xs transition-colors",
                    "hover:bg-muted",
                    !day.isCurrentMonth && "text-muted-foreground/40",
                    day.isToday &&
                      !isSelected &&
                      "ring-foreground font-medium ring-1",
                    isSelected &&
                      "bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                  key={day.date}
                  onClick={() => onChange(day.date)}
                  type="button"
                >
                  {Number.parseInt(day.date.slice(8), 10)}
                </button>
              );
            })}
          </div>

          {/* Clear button */}
          {value && (
            <div className="mt-1 border-t pt-1">
              <Button
                className="w-full"
                onClick={() => onChange(null)}
                size="xs"
                variant="ghost"
              >
                {t("clearDate")}
              </Button>
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
};

// -- Assignee picker --

type AssigneePickerProps = {
  workspaceId: string;
  taskId: string;
  assignees: {
    user: {
      id: string;
      name: string | null;
      image: string | null;
    };
  }[];
};

export const AssigneePicker = ({
  workspaceId,
  taskId,
  assignees,
}: AssigneePickerProps) => {
  const t = useTranslations("tasks");
  const queryClient = useQueryClient();
  const { data: members } = useQuery(workspaceMembersOptions(workspaceId));

  const assignedIds = new Set(assignees.map((a) => a.user.id));

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: taskKeys.detail(workspaceId, taskId),
    });
    await queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    });
  };

  const queryKey = entitiesKeys.all(workspaceId);

  const addAssignee = useMutation({
    mutationFn: async (userId: string) => {
      const response = await api
        .tasks({ workspaceId })
        .assignees.post({ taskId, userId, queryKey });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: invalidate,
  });

  const removeAssignee = useMutation({
    mutationFn: async (userId: string) => {
      const response = await api
        .tasks({ workspaceId })
        .assignees.delete({ taskId, userId, queryKey });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: invalidate,
  });

  const unassignedMembers = members?.filter(
    (m) => m.user && !assignedIds.has(m.user.id),
  );

  return (
    <div className="flex flex-col gap-1">
      {assignees.map((a) => (
        <div
          className="group/assignee flex items-center gap-1.5 rounded-md px-1.5 py-0.5"
          key={a.user.id}
        >
          {a.user.image ? (
            <img
              alt={a.user.name ?? ""}
              className="size-4 rounded-full"
              height={16}
              src={a.user.image}
              width={16}
            />
          ) : (
            <span className="bg-primary/10 flex size-4 items-center justify-center rounded-full text-[10px] font-medium">
              {a.user.name?.[0]?.toUpperCase() ?? "?"}
            </span>
          )}
          <span className="flex-1 truncate text-sm">{a.user.name}</span>
          <Button
            className="size-5 opacity-0 transition-opacity group-hover/assignee:opacity-100"
            disabled={removeAssignee.isPending}
            onClick={() => removeAssignee.mutate(a.user.id)}
            size="icon-xs"
            variant="ghost"
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ))}
      {unassignedMembers && unassignedMembers.length > 0 && (
        <Popover>
          <PopoverTrigger
            render={
              <button
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm transition-colors"
                type="button"
              />
            }
          >
            <PlusIcon className="size-3.5" />
            <span>{t("addAssignee")}</span>
          </PopoverTrigger>
          <PopoverPopup
            className="*:data-[slot=popover-viewport]:p-1!"
            side="bottom"
          >
            <div className="flex w-48 flex-col">
              {unassignedMembers.map((m) => {
                const user = m.user;
                if (!user) {
                  return null;
                }
                return (
                  <button
                    className="hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"
                    key={user.id}
                    onClick={() => addAssignee.mutate(user.id)}
                    type="button"
                  >
                    {user.image ? (
                      <img
                        alt={user.name ?? ""}
                        className="size-5 rounded-full"
                        height={20}
                        src={user.image}
                        width={20}
                      />
                    ) : (
                      <span className="bg-primary/10 flex size-5 items-center justify-center rounded-full text-xs font-medium">
                        {user.name?.[0]?.toUpperCase() ?? "?"}
                      </span>
                    )}
                    <span className="truncate">{user.name}</span>
                  </button>
                );
              })}
            </div>
          </PopoverPopup>
        </Popover>
      )}
      {assignees.length === 0 &&
        (!unassignedMembers || unassignedMembers.length === 0) && (
          <span className="text-muted-foreground px-1.5 text-sm">
            {t("noAssignees")}
          </span>
        )}
    </div>
  );
};
