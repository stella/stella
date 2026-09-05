import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  MinusIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import {
  isListItemType,
  ITEM_TYPE_TRANSLATION_KEYS,
} from "@/components/workspaces/tasks/task-detail-constants";
import { env } from "@/env";
import { useLocale } from "@/i18n/formatting-context";
import { localISODate } from "@/lib/local-iso-date";
import { UTC_CALENDAR_DATE_FORMAT } from "@/lib/relative-time";
import type { WorkspaceEntity } from "@/lib/types";

const PRIORITY_CONFIG: Record<
  string,
  { icon: typeof ArrowUpIcon; className: string }
> = {
  urgent: {
    icon: AlertCircleIcon,
    className: "text-destructive",
  },
  high: { icon: ArrowUpIcon, className: "text-warning" },
  medium: { icon: MinusIcon, className: "text-warning" },
  low: {
    icon: ArrowDownIcon,
    className: "text-foreground-muted dark:text-foreground",
  },
};

const isOverdue = (dueDate: string, status: string | null) =>
  status !== "done" && status !== "cancelled" && dueDate < localISODate();

type TaskBadgesProps = {
  entity: WorkspaceEntity;
  className?: string;
};

export const TaskBadges = ({ entity, className }: TaskBadgesProps) => {
  const locale = useLocale();
  const t = useTranslations();

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
  const listItemType = isListItemType(entity.listItemType)
    ? entity.listItemType
    : "task";
  const showItemType = env.VITE_FEATURE_LEGAL_LISTS && listItemType !== "task";

  if (!priorityCfg && !entity.dueDate && !showItemType) {
    return null;
  }

  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center gap-1.5 text-xs",
        className,
      )}
    >
      {showItemType && (
        <span className="bg-muted rounded px-1.5 py-0.5">
          {t(ITEM_TYPE_TRANSLATION_KEYS[listItemType])}
        </span>
      )}
      {priorityCfg && (
        <priorityCfg.icon className={cn("size-3", priorityCfg.className)} />
      )}
      {entity.dueDate && (
        <span
          className={cn(
            "flex items-center gap-0.5",
            overdue && "text-destructive",
          )}
        >
          <CalendarIcon className="size-3" />
          <span>
            {new Date(entity.dueDate).toLocaleDateString(
              locale,
              UTC_CALENDAR_DATE_FORMAT,
            )}
          </span>
        </span>
      )}
    </div>
  );
};
