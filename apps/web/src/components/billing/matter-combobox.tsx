import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";

import { entitySummariesOptions } from "@/lib/workspaces/queries/entities";

type MatterComboboxProps = {
  workspaceId: string;
  value: string;
  placeholder?: string;
  onChange: (matterId: string) => void;
};

export const MatterCombobox = ({
  workspaceId,
  value,
  onChange,
  placeholder,
}: MatterComboboxProps) => {
  const t = useTranslations();
  // The work items (documents, folders, tasks) inside one matter that billing
  // calls its "matters"; not matters themselves, so no matter icon.
  const { data: workItems } = useSuspenseQuery(
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
      <ComboboxInput
        placeholder={placeholder ?? t("billing.selectMatter")}
        size="default"
      />
      <ComboboxPopup>
        <ComboboxList>
          {workItems.map((workItem) => (
            <ComboboxItem key={workItem.id} value={workItem.id}>
              {workItem.name}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
};
