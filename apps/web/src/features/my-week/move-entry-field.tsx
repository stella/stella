import { useId } from "react";

import { useTranslations } from "use-intl";

import { Label } from "@stll/ui/label";

import {
  MatterCombobox,
  type MatterOption,
} from "@/components/workspaces/matter-combobox";

/**
 * The matter a draft entry belongs to, which its editor can change: saving
 * moves the entry, and the new matter's rates price it. Clearing the field
 * keeps the chosen matter, since an entry always belongs to one.
 */
export const MoveEntryField = ({
  organizationId,
  userId,
  currentMatterId,
  value,
  onChange,
}: {
  organizationId: string;
  userId: string;
  /** Where the entry is now. */
  currentMatterId: string;
  value: MatterOption;
  onChange: (matter: MatterOption) => void;
}) => {
  const t = useTranslations();
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t("common.matter")}</Label>
      <MatterCombobox
        activeOrganizationId={organizationId}
        id={id}
        onChange={(matter) => {
          if (matter !== null) {
            onChange(matter);
          }
        }}
        userId={userId}
        value={value}
      />
      {value.id !== currentMatterId && (
        <p className="text-muted-foreground text-xs">
          {t("billing.moveEntryHint")}
        </p>
      )}
    </div>
  );
};
