import { useState } from "react";

import { Button } from "@stll/ui/components/button";
import { Dialog, DialogPopup } from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import { stellaToast } from "@stll/ui/components/toast";
import { PlusIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { MatterCombobox } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-combobox";
import { useSplitTimeEntry } from "@/routes/_protected.workspaces/$workspaceId/-mutations/time-entries";

type SplitLine = {
  key: number;
  matterId: string;
  percentage: number;
};

let splitKeyCounter = 0;

type SplitEntryDialogProps = {
  workspaceId: string;
  entryId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const SplitEntryDialog = ({
  workspaceId,
  entryId,
  open,
  onOpenChange,
}: SplitEntryDialogProps) => {
  const t = useTranslations();
  const splitMutation = useSplitTimeEntry();

  const [splits, setSplits] = useState([
    { key: ++splitKeyCounter, matterId: "", percentage: 50 },
    { key: ++splitKeyCounter, matterId: "", percentage: 50 },
  ]);

  const totalPercentage = splits.reduce((sum, s) => sum + s.percentage, 0);

  const handleSubmit = () => {
    if (totalPercentage !== 100) {
      stellaToast.add({
        title: t("billing.split.totalMustBe100"),
        type: "error",
      });
      return;
    }

    const invalidMatter = splits.some((s) => !s.matterId);
    if (invalidMatter) {
      stellaToast.add({
        title: t("billing.matterRequired"),
        type: "error",
      });
      return;
    }

    splitMutation.mutate(
      {
        workspaceId,
        id: entryId,
        splits: splits.map((s) => ({
          matterId: s.matterId,
          percentage: s.percentage,
        })),
      },
      {
        onSuccess: () => onOpenChange(false),
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const updateSplit = (
    index: number,
    field: keyof SplitLine,
    value: string | number,
  ) => {
    setSplits((prev) =>
      prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    );
  };

  const addSplit = () => {
    if (splits.length >= 10) {
      return;
    }
    setSplits((prev) => [
      ...prev,
      { key: ++splitKeyCounter, matterId: "", percentage: 0 },
    ]);
  };

  const removeSplit = (index: number) => {
    if (splits.length <= 2) {
      return;
    }
    setSplits((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-md">
        <div className="flex flex-col gap-4 p-4">
          <h3 className="text-sm font-medium">
            {t("billing.split.splitEntry")}
          </h3>

          {splits.map((split, index) => (
            <div className="flex items-end gap-2" key={split.key}>
              <div className="flex-1">
                <Label>{t("common.matter")}</Label>
                <MatterCombobox
                  onChange={(val) => updateSplit(index, "matterId", val)}
                  value={split.matterId}
                  workspaceId={workspaceId}
                />
              </div>
              <div className="w-20">
                <Label>{t("billing.split.percentage")}</Label>
                <Input
                  inputMode="numeric"
                  max={100}
                  min={1}
                  onChange={(e) =>
                    updateSplit(
                      index,
                      "percentage",
                      Number(e.currentTarget.value),
                    )
                  }
                  type="number"
                  value={split.percentage}
                />
              </div>
              {splits.length > 2 && (
                <Button
                  className="text-destructive size-8"
                  onClick={() => removeSplit(index)}
                  size="icon"
                  variant="ghost"
                >
                  <TrashIcon className="size-3.5" />
                </Button>
              )}
            </div>
          ))}

          <div className="flex items-center justify-between">
            <Button
              disabled={splits.length >= 10}
              onClick={addSplit}
              size="sm"
              variant="outline"
            >
              <PlusIcon className="size-3.5" />
              {t("billing.split.addSplit")}
            </Button>
            <span
              className={
                totalPercentage === 100
                  ? "text-xs text-emerald-600"
                  : "text-destructive text-xs"
              }
            >
              {t("billing.split.percentValue", {
                value: String(totalPercentage),
              })}
            </span>
          </div>

          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)} variant="outline">
              {t("common.cancel")}
            </Button>
            <Button disabled={totalPercentage !== 100} onClick={handleSubmit}>
              {t("billing.split.splitEntry")}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
};
