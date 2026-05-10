import { SquareMinusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { OptionColor } from "@stll/api/types";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

import type { WorkspacePropertyOption } from "@/lib/types";
import { SelectColorIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";

const ColorIcon = ({ color }: { color: OptionColor | null }) => {
  if (!color) {
    return <SquareMinusIcon className="size-4" />;
  }

  return <SelectColorIcon color={color} />;
};

type SelectFallbackProps = {
  value: string | null;
  onValueChange: (value: string | null) => void;
  options: WorkspacePropertyOption[];
};
export const SelectFallback = ({
  value,
  onValueChange,
  options,
}: SelectFallbackProps) => {
  const t = useTranslations();

  const selectItems = [
    {
      label: (
        <div className="flex items-center gap-x-2 font-medium">
          <ColorIcon color={null} />
          {t("workspaces.properties.keepEmpty")}
        </div>
      ),
      value: null,
    },
    ...options.map((o) => ({
      label: (
        <div className="flex items-center gap-x-2 font-medium">
          <ColorIcon color={o.color} />
          {o.value}
        </div>
      ),
      value: o.value,
    })),
  ];

  return (
    <div>
      <span className="text-muted-foreground px-1 text-sm">
        {t("workspaces.properties.ifNoMatchFound")}
      </span>
      <Select items={selectItems} onValueChange={onValueChange} value={value}>
        <SelectTrigger className="hover:bg-muted border-0 shadow-none ring-0 before:shadow-none!">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {selectItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
};
