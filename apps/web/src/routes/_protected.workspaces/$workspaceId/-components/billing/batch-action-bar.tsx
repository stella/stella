import {
  CheckCheckIcon,
  CircleOffIcon,
  DollarSignIcon,
  TrashIcon,
  UndoIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { toastManager } from "@stella/ui/components/toast";

import { useBatchUpdateTimeEntries } from "@/routes/_protected.workspaces/$workspaceId/-mutations/time-entries";

type BatchActionBarProps = {
  workspaceId: string;
  selectedIds: string[];
  onClear: () => void;
};

export const BatchActionBar = ({
  workspaceId,
  selectedIds,
  onClear,
}: BatchActionBarProps) => {
  const t = useTranslations();
  const batchUpdate = useBatchUpdateTimeEntries();

  const handleAction = (
    action:
      | "approve"
      | "revert_to_draft"
      | "mark_billable"
      | "mark_non_billable"
      | "delete",
  ) => {
    batchUpdate.mutate(
      { workspaceId, ids: selectedIds, action },
      {
        onSuccess: () => onClear(),
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  if (selectedIds.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
      <span className="text-sm font-medium">
        {t("billing.selectedCount", { count: selectedIds.length })}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Button
          onClick={() => handleAction("approve")}
          size="sm"
          variant="outline"
        >
          <CheckCheckIcon className="size-3.5" />
          {t("billing.approve")}
        </Button>
        <Button
          onClick={() => handleAction("revert_to_draft")}
          size="sm"
          variant="outline"
        >
          <UndoIcon className="size-3.5" />
          {t("billing.revertToDraft")}
        </Button>
        <Button
          onClick={() => handleAction("mark_billable")}
          size="sm"
          variant="outline"
        >
          <DollarSignIcon className="size-3.5" />
          {t("billing.markBillableSelected")}
        </Button>
        <Button
          onClick={() => handleAction("mark_non_billable")}
          size="sm"
          variant="outline"
        >
          <CircleOffIcon className="size-3.5" />
          {t("billing.markNonBillableSelected")}
        </Button>
        <Button
          onClick={() => handleAction("delete")}
          size="sm"
          variant="destructive"
        >
          <TrashIcon className="size-3.5" />
          {t("billing.deleteSelected")}
        </Button>
      </div>
    </div>
  );
};
