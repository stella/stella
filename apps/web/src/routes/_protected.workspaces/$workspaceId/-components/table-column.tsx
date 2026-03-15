import type { PropsWithChildren } from "react";

import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";

import type {
  EntityKind,
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspacePropertyOption,
} from "@/lib/types";
import { CellResult } from "@/routes/_protected.workspaces/$workspaceId/-components/cell-result";
import { EditFieldDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/edit-field-dialog";
import type { EditableFieldContent } from "@/routes/_protected.workspaces/$workspaceId/-components/edit-field-dialog";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { PropertyPopover } from "@/routes/_protected.workspaces/$workspaceId/-components/property-popover";
import type { TableColumnDef } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
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

  // AI-model property: click opens peek PDF with justification
  if (property.tool.type === "ai-model" && field !== undefined) {
    const firstFile = getFirstFile(entity);
    const justFieldId = justification?.fileFieldIds.at(0);
    const fileFieldId = justFieldId ?? firstFile?.fieldId;

    // When the justification references a specific file,
    // look it up so label and mimeType match the actual PDF.
    const referencedFile =
      justFieldId !== undefined
        ? Object.values(entity.fields).find(
            (f) => f.id === justFieldId && f.content.type === "file",
          )
        : undefined;

    const fileName =
      (referencedFile?.content.type === "file"
        ? referencedFile.content.fileName
        : undefined) ??
      firstFile?.fileName ??
      entity.name ??
      "";

    const mimeType =
      referencedFile?.content.type === "file"
        ? referencedFile.content.mimeType
        : firstFile?.mimeType;

    if (fileFieldId) {
      return (
        <WithOpenEntityButton
          entityId={entity.entityId}
          fieldId={fileFieldId}
          justificationFieldId={field.id}
          label={fileName}
          mimeType={mimeType}
          propertyId={property.id}
          workspaceId={property.workspaceId}
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
  justificationFieldId: string;
  label: string;
  mimeType?: string | undefined;
  propertyId: string;
  workspaceId: string;
};

/** Makes the cell clickable to open the peek PDF viewer
 *  in the inspector with the AI justification visible. */
const WithOpenEntityButton = ({
  fieldId,
  entityId,
  justificationFieldId,
  label,
  mimeType,
  propertyId,
  workspaceId,
  children,
}: PropsWithChildren<WithOpenEntityButtonProps>) => {
  const navigate = useNavigate();
  const t = useTranslations();
  const openPdf = useInspectorStore((s) => s.openPdf);

  const activePropertyId = propertyId;

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="w-full cursor-pointer text-start"
      onClick={() =>
        openPdf({
          id: fieldId,
          entityId,
          label,
          mimeType,
          justificationFieldId,
          propertyId,
          workspaceId,
        })
      }
    >
      {children}
      <Button
        className="absolute end-2 bottom-2 hidden group-hover/cell-content:block"
        // eslint-disable-next-line typescript/no-misused-promises
        onClick={async (e) => {
          e.stopPropagation();

          await navigate({
            to: "/workspaces/$workspaceId/$viewId/pdf",
            params: { workspaceId, viewId: "all" },
            search: {
              file: {
                fieldId,
                pageNumber: 1,
                scaleOffset: 0,
              },
              justification: undefined,
              entity: {
                id: entityId,
                visible: true,
                activePropertyId,
              },
            },
          });
        }}
        size="xs"
      >
        {t("common.open")}
      </Button>
    </div>
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
