import type { AnyFieldApi } from "@tanstack/react-form";
import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";

import type { WorkspaceToolType } from "@/lib/types";

type SelectToolProps = {
  field: AnyFieldApi;
};

export const SelectTool = ({ field }: SelectToolProps) => {
  const t = useTranslations();

  const selectItems: { label: string; value: WorkspaceToolType }[] = [
    { label: t("workspaces.tools.aiModel"), value: "ai-model" },
    { label: t("workspaces.tools.manualInput"), value: "manual-input" },
  ];

  return (
    <Select
      items={selectItems}
      onValueChange={field.handleChange}
      value={field.state.value}
    >
      <SelectTrigger className="hover:bg-muted border-0 px-1.5 shadow-none ring-0 before:shadow-none!">
        <SelectValue className="font-semibold" />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {selectItems.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};
