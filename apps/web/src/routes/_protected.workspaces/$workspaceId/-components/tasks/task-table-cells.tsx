import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  CircleIcon,
  MinusIcon,
  XCircleIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import type { WorkspaceEntity } from "@/lib/types";

// -- Status cell --

const STATUS_ICONS: Record<string, typeof CircleIcon> = {
  open: CircleIcon,
  in_progress: CircleDotIcon,
  in_review: CircleDotIcon,
  done: CheckCircle2Icon,
  cancelled: XCircleIcon,
};

const STATUS_COLORS: Record<string, string> = {
  open: "text-muted-foreground",
  in_progress: "text-blue-500",
  in_review: "text-amber-500",
  done: "text-green-500",
  cancelled: "text-red-400",
};

export const StatusCell = ({ entity }: { entity: WorkspaceEntity }) => {
  const t = useTranslations("tasks");

  if (!entity.status) {
    return null;
  }

  const Icon = STATUS_ICONS[entity.status] ?? CircleIcon;
  const color = STATUS_COLORS[entity.status] ?? "text-muted-foreground";

  return (
    <span className="flex items-center gap-1.5 text-xs">
      <Icon className={cn("size-3.5", color)} />
      <span>
        {t(
          // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          `statusValues.${entity.status}` as "statusValues.open",
        )}
      </span>
    </span>
  );
};

// -- Priority cell --

const PRIORITY_ICONS: Record<string, typeof MinusIcon> = {
  none: MinusIcon,
  urgent: AlertCircleIcon,
  high: ArrowUpIcon,
  medium: MinusIcon,
  low: ArrowDownIcon,
};

const PRIORITY_COLORS: Record<string, string> = {
  none: "text-muted-foreground",
  urgent: "text-red-500",
  high: "text-orange-500",
  medium: "text-yellow-500",
  low: "text-blue-400",
};

export const PriorityCell = ({ entity }: { entity: WorkspaceEntity }) => {
  const t = useTranslations("tasks");

  if (!entity.priority) {
    return null;
  }

  const Icon = PRIORITY_ICONS[entity.priority] ?? MinusIcon;
  const color = PRIORITY_COLORS[entity.priority] ?? "text-muted-foreground";

  return (
    <span className="flex items-center gap-1.5 text-xs">
      <Icon className={cn("size-3.5", color)} />
      <span>
        {t(
          // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          `priorityValues.${entity.priority}` as "priorityValues.none",
        )}
      </span>
    </span>
  );
};

// -- Due date cell --

export const DueDateCell = ({ entity }: { entity: WorkspaceEntity }) => {
  const t = useTranslations("tasks");
  const locale = useLocale();

  if (!entity.dueDate) {
    return null;
  }

  const isOverdue =
    entity.status !== "done" &&
    entity.status !== "cancelled" &&
    entity.dueDate < new Date().toISOString().slice(0, 10);

  return (
    <span
      className={cn(
        "flex items-center gap-1 text-xs",
        isOverdue && "text-red-500",
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
      {isOverdue && (
        <span className="text-[10px] font-medium">{t("overdue")}</span>
      )}
    </span>
  );
};
