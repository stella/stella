import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

import type { WorkspacePropertyOption } from "@/lib/types";
import { SelectColorIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";

type FieldValueSelectProps = (
  | {
      type: "single-select";
      value: string | null | string[];
      onChange: (value: string | null) => void;
    }
  | {
      type: "multi-select";
      value: string | null | string[];
      onChange: (value: string[]) => void;
    }
) & {
  options: WorkspacePropertyOption[];
  /** Open the dropdown as soon as it mounts (for click-to-edit cells). */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const FieldValueSelect = ({
  options,
  type,
  value,
  onChange,
  defaultOpen,
  onOpenChange,
}: FieldValueSelectProps) => {
  const items = options.map((option) => ({
    label: option.value,
    value: option,
  }));

  return (
    <Select
      defaultOpen={defaultOpen}
      items={items}
      multiple={type === "multi-select"}
      onOpenChange={onOpenChange}
      onValueChange={(newValue) => {
        if (type === "multi-select" && Array.isArray(newValue)) {
          onChange(newValue);
        } else if (type === "single-select" && !Array.isArray(newValue)) {
          onChange(newValue === value ? null : newValue || null);
        }
      }}
      value={value}
    >
      <SelectTrigger className="grid grid-cols-[1fr_auto]">
        <SelectValue className="truncate">
          {(current: string | null | string[]) => (
            <SelectValueContent options={options} type={type} value={current} />
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup
        alignItemWithTrigger={false}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
      >
        {items.map(({ label, value: option }) => (
          <SelectItem key={option.value} value={option.value}>
            <div className="flex items-center gap-x-1.5">
              <SelectColorIcon color={option.color} />
              {label}
            </div>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

type SelectValueContentProps = {
  value: string | string[] | null;
  options: WorkspacePropertyOption[];
  type: "single-select" | "multi-select";
};

const SelectValueContent = ({
  value,
  options,
  type,
}: SelectValueContentProps) => {
  const t = useTranslations();

  if (value === null || (Array.isArray(value) && value.length === 0)) {
    return type === "multi-select"
      ? t("workspaces.fields.selectValues")
      : t("workspaces.fields.selectAValue");
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  const color = options.find((o) => o.value === value)?.color;

  return (
    <div className="flex items-center gap-x-1.5">
      <SelectColorIcon color={color} />
      {value}
    </div>
  );
};
