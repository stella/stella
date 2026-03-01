import { PencilIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { cn } from "@stella/ui/lib/utils";

import { formatMinutes } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/duration-input";

type TimeEntry = {
  id: string;
  matterId: string;
  dateWorked: string;
  durationMinutes: number;
  billedMinutes: number;
  narrative: string;
  billable: boolean;
  status: string;
  userName: string | null;
  timerStartedAt: string | null;
};

type TimeEntryRowProps = {
  entry: TimeEntry;
  matterName: string;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
};

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  approved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  billed: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  written_off: "bg-red-500/10 text-red-700 dark:text-red-400",
};

export const TimeEntryRow = ({
  entry,
  matterName,
  onEdit,
  onDelete,
}: TimeEntryRowProps) => {
  const t = useTranslations();

  const isActive = entry.timerStartedAt !== null;

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-md border px-3 py-2 transition-colors hover:bg-muted/50",
        isActive && "border-green-500/30 bg-green-500/5",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{matterName}</span>
          {!entry.billable && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
              {t("billing.nonBillable")}
            </span>
          )}
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[0.625rem]",
              STATUS_STYLES[entry.status] ?? STATUS_STYLES.draft,
            )}
          >
            {
              {
                draft: t("billing.statuses.draft"),
                approved: t("billing.statuses.approved"),
                billed: t("billing.statuses.billed"),
                written_off: t("billing.statuses.written_off"),
              }[entry.status]
            }
          </span>
        </div>
        {entry.narrative && (
          <p className="truncate text-xs text-muted-foreground">
            {entry.narrative}
          </p>
        )}
      </div>

      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
        {isActive ? (
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 animate-pulse rounded-full bg-green-500" />
            {t("billing.running")}
          </span>
        ) : (
          formatMinutes(entry.durationMinutes)
        )}
      </span>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {entry.status === "draft" && (
          <>
            <Button
              className="size-7"
              onClick={() => onEdit(entry.id)}
              size="icon"
              variant="ghost"
            >
              <PencilIcon className="size-3.5" />
            </Button>
            <Button
              className="size-7 text-destructive"
              onClick={() => onDelete(entry.id)}
              size="icon"
              variant="ghost"
            >
              <TrashIcon className="size-3.5" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
};
