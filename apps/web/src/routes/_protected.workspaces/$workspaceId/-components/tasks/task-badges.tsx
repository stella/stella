import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  MinusIcon,
} from "lucide-react";
import { useLocale } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import type { WorkspaceEntity } from "@/lib/types";

const PRIORITY_CONFIG: Record<
  string,
  { icon: typeof ArrowUpIcon; className: string }
> = {
  urgent: {
    icon: AlertCircleIcon,
    // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present
    className: "text-red-500 dark:text-red-400",
  },
  high: { icon: ArrowUpIcon, className: "text-orange-500" },
  medium: { icon: MinusIcon, className: "text-yellow-500" },
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  low: { icon: ArrowDownIcon, className: "text-blue-400 dark:text-blue-300" },
};

const isOverdue = (dueDate: string, status: string | null) =>
  status !== "done" &&
  status !== "cancelled" &&
  dueDate < new Date().toISOString().slice(0, 10);

type TaskBadgesProps = {
  entity: WorkspaceEntity;
  className?: string;
};

export const TaskBadges = ({ entity, className }: TaskBadgesProps) => {
  const locale = useLocale();

  if (entity.kind !== "task") {
    return null;
  }

  const priorityCfg =
    entity.priority && entity.priority !== "none"
      ? PRIORITY_CONFIG[entity.priority]
      : null;
  const overdue = entity.dueDate
    ? isOverdue(entity.dueDate, entity.status)
    : false;

  if (!priorityCfg && !entity.dueDate) {
    return null;
  }

  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center gap-1.5 text-xs",
        className,
      )}
    >
      {priorityCfg && (
        <priorityCfg.icon className={cn("size-3", priorityCfg.className)} />
      )}
      {entity.dueDate && (
        <span
          className={cn(
            "flex items-center gap-0.5",
            overdue && "text-red-500 dark:text-red-400",
          )}
        >
          <CalendarIcon className="size-3" />
          <span>
            {new Date(entity.dueDate).toLocaleDateString(locale, {
              year: "numeric",
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })}
          </span>
        </span>
      )}
    </div>
  );
};
