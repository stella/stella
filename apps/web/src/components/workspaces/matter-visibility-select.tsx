import { useTranslations } from "use-intl";

import {
  isMatterVisibility,
  MATTER_VISIBILITIES,
} from "@stll/api-contract/matter-visibility";
import type { MatterVisibility } from "@stll/api-contract/matter-visibility";
import type { ControlSize } from "@stll/ui/control-size";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { MATTER_VISIBILITY_COPY } from "@/components/workspaces/matter-visibility.logic";

type MatterVisibilitySelectProps = {
  disabled: boolean;
  label: string;
  onValueChange: (visibility: MatterVisibility) => void;
  size: ControlSize;
  value: MatterVisibility;
};

/** The three visibility levels, each with one line on who can open the matter. */
export const MatterVisibilitySelect = ({
  disabled,
  label,
  onValueChange,
  size,
  value,
}: MatterVisibilitySelectProps) => {
  const t = useTranslations();

  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        if (isMatterVisibility(next)) {
          onValueChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger aria-label={label} className="w-full" size={size}>
        <SelectValue>{t(MATTER_VISIBILITY_COPY[value].label)}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false} className="min-w-72">
        {MATTER_VISIBILITIES.map((visibility) => {
          const copy = MATTER_VISIBILITY_COPY[visibility];
          return (
            <SelectItem
              key={visibility}
              label={t(copy.label)}
              value={visibility}
            >
              <div className="flex flex-col gap-0.5 py-0.5">
                <span>{t(copy.label)}</span>
                <span className="text-muted-foreground text-xs leading-tight">
                  {t(copy.description)}
                </span>
              </div>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
};
