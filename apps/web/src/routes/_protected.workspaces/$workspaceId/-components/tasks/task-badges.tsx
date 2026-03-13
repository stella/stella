import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  MinusIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import type { WorkspaceEntity } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = {
  open: "bg-muted-foreground",
  in_progress: "bg-blue-500",
  in_review: "bg-amber-500",
  done: "bg-green-500",
  cancelled: "bg-red-400",
};

const PRIORITY_CONFIG: Record<
  string,
  { icon: typeof ArrowUpIcon; className: string }
> = {
  urgent: { icon: AlertCircleIcon, className: "text-red-500" },
  high: { icon: ArrowUpIcon, className: "text-orange-500" },
  medium: { icon: MinusIcon, className: "text-yellow-500" },
  low: { icon: ArrowDownIcon, className: "text-blue-400" },
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
  const t = useTranslations("tasks");

  if (entity.kind !== "task") {
    return null;
  }

  const statusColor = entity.status ? STATUS_COLORS[entity.status] : null;
  const priorityCfg =
    entity.priority && entity.priority !== "none"
      ? PRIORITY_CONFIG[entity.priority]
      : null;
  const overdue = entity.dueDate
    ? isOverdue(entity.dueDate, entity.status)
    : false;

  if (!statusColor && !priorityCfg && !entity.dueDate) {
    return null;
  }

  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center gap-1.5 text-xs",
        className,
      )}
    >
      {statusColor && (
        <span
          className={cn("size-2 rounded-full", statusColor)}
          title={
            entity.status
              ? t(
                  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                  `statusValues.${entity.status}` as "statusValues.open",
                )
              : undefined
          }
        />
      )}
      {priorityCfg && (
        <priorityCfg.icon className={cn("size-3", priorityCfg.className)} />
      )}
      {entity.dueDate && (
        <span
          className={cn("flex items-center gap-0.5", overdue && "text-red-500")}
        >
          <CalendarIcon className="size-3" />
          <span>
            {new Date(entity.dueDate).toLocaleDateString(undefined, {
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
