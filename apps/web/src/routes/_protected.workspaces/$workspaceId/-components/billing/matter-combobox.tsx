import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/components/combobox";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { entitySummariesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

type MatterComboboxProps = {
  workspaceId: string;
  value: string;
  onChange: (matterId: string) => void;
};

export const MatterCombobox = ({
  workspaceId,
  value,
  onChange,
}: MatterComboboxProps) => {
  const t = useTranslations();
  const { data: matters } = useSuspenseQuery(
    entitySummariesOptions(workspaceId),
  );

  return (
    <Combobox
      onValueChange={(val) => {
        if (val) {
          onChange(val);
        }
      }}
      value={value || null}
    >
      <ComboboxInput placeholder={t("billing.selectMatter")} size="default" />
      <ComboboxPopup>
        <ComboboxList>
          {matters.map((matter) => (
            <ComboboxItem key={matter.id} value={matter.id}>
              {matter.name ?? t("workspaces.defaultName")}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
};
