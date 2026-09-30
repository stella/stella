import { useTranslations } from "use-intl";

import {
  TIME_ENTRY_ACTIVITY_GROUP,
  type TimeEntryActivityGroup,
} from "@stll/api-contract";
import { Checkbox } from "@stll/ui/checkbox";
import { Label } from "@stll/ui/label";

type ManualTimeEntryBillingFieldsProps = {
  activityGroup: TimeEntryActivityGroup;
  id: string;
  billable: boolean;
  onBillableChange: (billable: boolean) => void;
};

export const ManualTimeEntryBillingFields = ({
  activityGroup,
  id,
  billable,
  onBillableChange,
}: ManualTimeEntryBillingFieldsProps) => {
  const t = useTranslations("billing");
  if (activityGroup === TIME_ENTRY_ACTIVITY_GROUP.INTERNAL) {
    return null;
  }
  return (
    <div className="flex min-h-11 items-center gap-2">
      <Checkbox checked={billable} id={id} onCheckedChange={onBillableChange} />
      <Label htmlFor={id}>{t("billable")}</Label>
    </div>
  );
};
