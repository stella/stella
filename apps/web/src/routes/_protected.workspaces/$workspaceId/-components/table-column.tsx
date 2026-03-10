import type { PropsWithChildren } from "react";
import { useNavigate } from "@tanstack/react-router";
import { produce } from "immer";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";

import type {
  EntityKind,
  WorkspaceEntity,
  WorkspaceJustification,
  WorkspaceProperty,
  WorkspacePropertyOption,
} from "@/lib/types";
import { CellResult } from "@/routes/_protected.workspaces/$workspaceId/-components/cell-result";
import {
  EditFieldDialog,
  type EditableFieldContent,
} from "@/routes/_protected.workspaces/$workspaceId/-components/edit-field-dialog";
import { PropertyPopover } from "@/routes/_protected.workspaces/$workspaceId/-components/property-popover";
import type { TableColumnDef } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { useCreateBBoxes } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-b-boxes";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

export const getPropertyColumn = (
  property: WorkspaceProperty,
): TableColumnDef => ({
  id: property.id,
  accessorKey: property.id,
  accessorFn: (row) => row.fields[property.id],
  header: (ctx) => <PropertyPopover header={ctx.header} property={property} />,
  size: 200,
  cell: (props) => (
    <PropertyCell entity={props.row.original} property={property} />
  ),
});

const PropertyCell = ({
  entity,
  property,
}: {
  entity: WorkspaceEntity;
  property: WorkspaceProperty;
}) => {
  const field = entity.fields[property.id];
  const fieldContent = field?.content;

  const justification = useWorkspaceStore((s) =>
    s.justifications.find((j) => j.fieldId === field?.id),
  );

  if (fieldContent?.type === "pending") {
    return <CellResult field={field} property={property} />;
  }

  if (property.content.type === "file" || fieldContent?.type === "file") {
    return <CellResult field={field} property={property} />;
  }

  if (property.tool.type === "manual-input") {
    const options =
      property.content.type === "single-select" ||
      property.content.type === "multi-select"
        ? property.content.options
        : [];

    // Only show edit button for editable content types
    const editableContent =
      fieldContent?.type === "error" || fieldContent?.type === "unsupported"
        ? undefined
        : fieldContent;

    return (
      <WithEditFieldButton
        entityId={entity.entityId}
        entityKind={entity.kind}
        fieldContent={editableContent}
        options={options}
        propertyId={property.id}
        propertyType={property.content.type}
        workspaceId={property.workspaceId}
      >
        <CellResult field={field} property={property} />
      </WithEditFieldButton>
    );
  }

  // AI-model property: link to file viewer when justification exists
  if (property.tool.type === "ai-model") {
    const fileFieldId =
      justification?.fileFieldIds.at(0) ?? getFirstFile(entity)?.fieldId;

    if (justification && fileFieldId) {
      return (
        <WithOpenEntityButton
          activePropertyId={property.id}
          entityId={entity.entityId}
          fieldId={fileFieldId}
          justification={justification}
        >
          <CellResult field={field} property={property} />
        </WithOpenEntityButton>
      );
    }
  }

  return <CellResult field={field} property={property} />;
};

type WithOpenEntityButtonProps = {
  fieldId: string;
  entityId: string;
  justification: WorkspaceJustification;
  activePropertyId: string;
};

const WithOpenEntityButton = ({
  fieldId,
  entityId,
  justification,
  activePropertyId,
  children,
}: PropsWithChildren<WithOpenEntityButtonProps>) => {
  const t = useTranslations();
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/pdf",
  });
  const createBoundingBoxes = useCreateBBoxes({
    justification,
  });

  return (
    <>
      {children}
      <Button
        className="absolute end-2 bottom-2 hidden group-hover/cell-content:block"
        onClick={async () => {
          createBoundingBoxes();

          await navigate({
            to: "/workspaces/$workspaceId/$viewId/pdf",
            search: (prev) =>
              produce(prev, (s) => {
                s.file = {
                  fieldId,
                  pageNumber: 1,
                  scaleOffset: 0,
                };
                s.justification = undefined;
                s.entity = {
                  id: entityId,
                  visible: true,
                  activePropertyId,
                };
              }),
          });
        }}
        size="xs"
      >
        {t("common.open")}
      </Button>
    </>
  );
};

type WithEditFieldButtonProps = {
  entityId: string;
  propertyId: string;
  workspaceId: string;
  propertyType: EditableFieldContent["type"];
  entityKind: EntityKind;
  options: WorkspacePropertyOption[];
  fieldContent: EditableFieldContent | undefined;
};

const WithEditFieldButton = ({
  entityId,
  propertyId,
  workspaceId,
  propertyType,
  entityKind,
  options,
  fieldContent,
  children,
}: PropsWithChildren<WithEditFieldButtonProps>) => {
  const editableFieldContent =
    fieldContent ?? getDefaultFieldContent(propertyType);

  return (
    <>
      {children}
      <EditFieldDialog
        className="absolute end-2 bottom-2 hidden group-hover/cell-content:block"
        entityId={entityId}
        entityKind={entityKind}
        fieldContent={editableFieldContent}
        options={options}
        propertyId={propertyId}
        workspaceId={workspaceId}
      />
    </>
  );
};

const getDefaultFieldContent = (
  propertyType: EditableFieldContent["type"],
): EditableFieldContent => {
  if (propertyType === "text" || propertyType === "single-select") {
    return {
      version: 1,
      type: propertyType,
      value: "",
    };
  }

  if (propertyType === "date") {
    return {
      version: 1,
      type: "date",
      value: null,
    };
  }

  if (propertyType === "int") {
    return {
      version: 1,
      type: "int",
      value: 0,
      currency: null,
    };
  }

  return {
    version: 1,
    type: "multi-select",
    value: [],
  };
};
