import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stella/ui/components/combobox";

import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

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
  const { data: entities } = useSuspenseQuery(entitiesOptions(workspaceId));

  // Extract matter-like entities (documents, folders)
  // and build a name map from the "name" field
  const matters = useMemo(() => {
    if (!entities) {
      return [];
    }
    return entities.map((entity) => {
      const nameField = entity.fields.find(
        (f) => f.content.type === "text" || f.content.type === "file",
      );
      const name =
        nameField && "value" in nameField.content
          ? nameField.content.value
          : nameField && "filename" in nameField.content
            ? nameField.content.filename
            : t("workspaces.defaultName");
      return {
        id: entity.entityId,
        name: String(name),
      };
    });
  }, [entities, t]);

  return (
    <Combobox
      onValueChange={(val) => {
        if (val) {
          onChange(String(val));
        }
      }}
      value={value || null}
    >
      <ComboboxInput placeholder={t("billing.selectMatter")} size="default" />
      <ComboboxPopup>
        <ComboboxList>
          {matters.map((matter) => (
            <ComboboxItem key={matter.id} value={matter.id}>
              {matter.name}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
};
