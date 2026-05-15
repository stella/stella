import type { PropsWithChildren } from "react";

import { EyeIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";
import { ActiveEditBadge } from "@/routes/_protected.workspaces/$workspaceId/-components/active-edit-badge";
import { CellMetadataFlags } from "@/routes/_protected.workspaces/$workspaceId/-components/cell-metadata-flags";
import { CellResult } from "@/routes/_protected.workspaces/$workspaceId/-components/cell-result";
import { EditableField } from "@/routes/_protected.workspaces/$workspaceId/-components/editable-field";
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
  const cellMetadata = entity.cellMetadata[property.id];

  const justification = useWorkspaceStore((s) =>
    s.justifications.find((j) => j.fieldId === field?.id),
  );
  const extractionPreview = useWorkspaceStore((s) =>
    fieldContent?.type === "pending"
      ? s.getExtractionPreview(entity.entityId, property.id)
      : null,
  );

  if (fieldContent?.type === "pending") {
    return (
      <CellResult
        extractionPreview={extractionPreview}
        field={field}
        property={property}
      />
    );
  }

  if (property.content.type === "file" || fieldContent?.type === "file") {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <CellMetadataFlags
          entityId={entity.entityId}
          metadata={cellMetadata}
          propertyId={property.id}
          workspaceId={property.workspaceId}
        />
        <CellResult field={field} property={property} />
        {entity.activeEditBy && (
          <ActiveEditBadge
            className="shrink-0"
            image={entity.activeEditBy.image}
            name={entity.activeEditBy.name}
          />
        )}
      </span>
    );
  }

  if (property.tool.type === "manual-input") {
    return (
      <>
        <CellMetadataFlags
          entityId={entity.entityId}
          metadata={cellMetadata}
          propertyId={property.id}
          workspaceId={property.workspaceId}
        />
        <EditableField
          content={fieldContent}
          entityId={entity.entityId}
          entityKind={entity.kind}
          property={property}
          propertyId={property.id}
          showDateIcon={false}
          workspaceId={property.workspaceId}
        />
      </>
    );
  }

  // AI-model property: click opens peek PDF with justification
  if (field !== undefined) {
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
    const pdfFileId =
      referencedFile?.content.type === "file"
        ? referencedFile.content.pdfFileId
        : firstFile?.pdfFileId;

    if (fileFieldId) {
      return (
        <WithOpenEntityButton
          entityId={entity.entityId}
          fieldId={fileFieldId}
          justificationFieldId={field.id}
          label={fileName}
          mimeType={mimeType}
          pdfFileId={pdfFileId}
          propertyId={property.id}
          workspaceId={property.workspaceId}
        >
          <CellMetadataFlags
            entityId={entity.entityId}
            metadata={cellMetadata}
            propertyId={property.id}
            workspaceId={property.workspaceId}
          />
          <CellResult field={field} property={property} />
        </WithOpenEntityButton>
      );
    }
  }

  return (
    <>
      <CellMetadataFlags
        entityId={entity.entityId}
        metadata={cellMetadata}
        propertyId={property.id}
        workspaceId={property.workspaceId}
      />
      <CellResult field={field} property={property} />
    </>
  );
};

type WithOpenEntityButtonProps = {
  fieldId: string;
  entityId: string;
  justificationFieldId: string;
  label: string;
  mimeType?: string | undefined;
  pdfFileId?: string | null | undefined;
  propertyId: string;
  workspaceId: string;
};

/** Shows a peek PDF preview in the inspector with the AI justification visible. */
const WithOpenEntityButton = ({
  fieldId,
  entityId,
  justificationFieldId,
  label,
  mimeType,
  pdfFileId,
  propertyId,
  workspaceId,
  children,
}: PropsWithChildren<WithOpenEntityButtonProps>) => {
  const t = useTranslations();
  const openFile = useInspectorStore((s) => s.openFile);
  const handleOpenPreview = () => {
    openFile({
      id: fieldId,
      entityId,
      label,
      mimeType,
      pdfFileId: pdfFileId ?? null,
      justificationFieldId,
      propertyId,
      workspaceId,
    });
  };

  return (
    <div className="w-full min-w-0 text-start">
      {children}
      <Button
        className="text-foreground-ghost hover:text-foreground absolute end-1.5 bottom-1.5 hidden h-6 gap-1 px-1.5 text-xs opacity-70 group-data-[expanded-cell]/cell-content:flex hover:opacity-100"
        data-row-expansion-ignore
        onClick={(event) => {
          event.stopPropagation();
          handleOpenPreview();
        }}
        size="xs"
        variant="ghost"
      >
        <EyeIcon className="size-3.5" />
        {t("common.preview")}
      </Button>
    </div>
  );
};
