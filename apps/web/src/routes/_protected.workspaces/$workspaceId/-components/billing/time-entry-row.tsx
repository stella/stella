import { useState } from "react";

import {
  CheckCheckIcon,
  PencilIcon,
  ScissorsIcon,
  TrashIcon,
  UndoIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { prorateHourlyCents } from "@stll/money";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { cn } from "@stll/ui/lib/utils";

import { usePermissions } from "@/hooks/use-permissions";
import { formatMinutes } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/duration-input";
import { formatCurrencyAmount } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-currency";
import { SplitEntryDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/split-entry-dialog";
import { STATUS_STYLES } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/status-styles";

type TimeEntry = {
  id: string;
  matterId: string;
  dateWorked: string;
  durationMinutes: number;
  billedMinutes: number;
  rateAtEntry: number;
  currency: string;
  narrative: string;
  invoiceNarrative: string | null;
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
  onStatusChange?: (id: string, status: "draft" | "approved") => void;
  selected?: boolean;
  onSelect?: (id: string, selected: boolean) => void;
  workspaceId: string;
};

export const TimeEntryRow = ({
  entry,
  matterName,
  onEdit,
  onDelete,
  onStatusChange,
  selected,
  onSelect,
  workspaceId,
}: TimeEntryRowProps) => {
  const t = useTranslations();
  const canUpdateEntry = usePermissions({ timeEntry: ["update"] });
  const canDeleteEntry = usePermissions({ timeEntry: ["delete"] });
  const [splitOpen, setSplitOpen] = useState(false);

  const isActive = entry.timerStartedAt !== null;
  const billedAmount = prorateHourlyCents({
    billedMinutes: entry.billedMinutes,
    hourlyRateCents: entry.rateAtEntry,
  });

  return (
    <>
      <div
        className={cn(
          "group hover:bg-muted/50 flex items-center gap-3 rounded-md border px-3 py-2 transition-colors",
          isActive && "border-success/30 bg-success/8",
          selected && "border-primary/30 bg-primary/5",
        )}
      >
        {onSelect && (
          <Checkbox
            checked={selected ?? false}
            onCheckedChange={(checked) => onSelect(entry.id, checked)}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{matterName}</span>
            {!entry.billable && (
              <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[0.625rem]">
                {t("billing.nonBillable")}
              </span>
            )}
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[0.625rem]",
                STATUS_STYLES[entry.status] ?? STATUS_STYLES["draft"],
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
            <p className="text-muted-foreground truncate text-xs">
              {entry.narrative}
            </p>
          )}
        </div>

        {/* Billing amount */}
        {entry.billable && billedAmount > 0 && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {formatCurrencyAmount(billedAmount, entry.currency)}
          </span>
        )}

        <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
          {isActive ? (
            <span className="flex items-center gap-1.5">
              <span className="bg-success size-1.5 animate-pulse rounded-full" />
              {t("billing.running")}
            </span>
          ) : (
            formatMinutes(entry.durationMinutes)
          )}
        </span>

        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {/* Approval actions */}
          {entry.status === "draft" && onStatusChange && canUpdateEntry && (
            <Button
              className="size-7"
              onClick={() => onStatusChange(entry.id, "approved")}
              size="icon"
              title={t("billing.approve")}
              variant="ghost"
            >
              <CheckCheckIcon className="size-3.5" />
            </Button>
          )}
          {entry.status === "approved" && onStatusChange && canUpdateEntry && (
            <Button
              className="size-7"
              onClick={() => onStatusChange(entry.id, "draft")}
              size="icon"
              title={t("billing.revertToDraft")}
              variant="ghost"
            >
              <UndoIcon className="size-3.5" />
            </Button>
          )}

          {/* Split */}
          {(entry.status === "draft" || entry.status === "approved") &&
            canUpdateEntry && (
              <Button
                className="size-7"
                onClick={() => setSplitOpen(true)}
                size="icon"
                title={t("billing.split.splitEntry")}
                variant="ghost"
              >
                <ScissorsIcon className="size-3.5" />
              </Button>
            )}

          {entry.status === "draft" && canUpdateEntry && (
            <Button
              className="size-7"
              onClick={() => onEdit(entry.id)}
              size="icon"
              variant="ghost"
            >
              <PencilIcon className="size-3.5" />
            </Button>
          )}
          {entry.status === "draft" && canDeleteEntry && (
            <Button
              className="text-destructive size-7"
              onClick={() => onDelete(entry.id)}
              size="icon"
              variant="ghost"
            >
              <TrashIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <SplitEntryDialog
        entryId={entry.id}
        onOpenChange={setSplitOpen}
        open={splitOpen}
        workspaceId={workspaceId}
      />
    </>
  );
};
