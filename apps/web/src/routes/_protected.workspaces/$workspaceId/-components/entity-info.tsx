import {
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@stll/ui/components/accordion";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { EntityField, EntityKind } from "@/lib/types";
import { EditableField } from "@/routes/_protected.workspaces/$workspaceId/-components/editable-field";
import { Justification } from "@/routes/_protected.workspaces/$workspaceId/-components/justification";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

export const skipFieldFilter = (content: EntityField["content"]) =>
  content.type === "error" ||
  content.type === "pending" ||
  content.type === "file";

type FieldInfoProps = {
  entityKind: EntityKind;
  workspaceId: string;
  propertyId: string;
  field: EntityField;
  entityId: string;
};

export const FieldInfo = ({
  entityKind,
  workspaceId,
  propertyId,
  field,
  entityId,
}: FieldInfoProps) => {
  const t = useTranslations();
  const { data: property } = useSuspenseQuery({
    ...propertiesOptions(workspaceId),
    select: (data) => data.find((p) => p.id === propertyId),
  });
  const content = field?.content;
  const justification = useWorkspaceStore((s) =>
    s.justifications.find((j) => j.fieldId === field.id),
  );

  if (
    property === undefined ||
    property === null ||
    content === undefined ||
    content === null ||
    property.content.type === "file" ||
    skipFieldFilter(content)
  ) {
    return null;
  }

  return (
    <AccordionItem value={propertyId}>
      <AccordionTrigger className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <PropertyIcon className="size-4" type={property.content.type} />
          <span className="truncate font-medium">{property.name}</span>
        </div>
      </AccordionTrigger>
      <AccordionPanel className="px-3 pb-2">
        <div className="flex flex-col gap-2">
          <EditableField
            content={field?.content}
            entityId={entityId}
            entityKind={entityKind}
            property={property}
            propertyId={propertyId}
            readonly={property.tool.type === "ai-model"}
            workspaceId={workspaceId}
          />
          {justification && (
            <div className="flex flex-col gap-0.5 text-sm">
              <h1 className="text-muted-foreground text-sm font-medium">
                {t("workspaces.justification")}
              </h1>
              <Justification
                justification={justification}
                workspaceId={workspaceId}
              />
            </div>
          )}
        </div>
      </AccordionPanel>
    </AccordionItem>
  );
};
