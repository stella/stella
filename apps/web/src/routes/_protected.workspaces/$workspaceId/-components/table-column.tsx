import { useState, type PropsWithChildren } from "react";

import { EyeIcon, RefreshCwIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import type {
  ViewFilterCondition,
  WorkspaceEntity,
  WorkspaceProperty,
} from "@/lib/types";
import { ActiveEditBadge } from "@/routes/_protected.workspaces/$workspaceId/-components/active-edit-badge";
import {
  CellMetadataFlags,
  useCellMetadataFlags,
} from "@/routes/_protected.workspaces/$workspaceId/-components/cell-metadata-flags";
import { CellResult } from "@/routes/_protected.workspaces/$workspaceId/-components/cell-result";
import { EditableField } from "@/routes/_protected.workspaces/$workspaceId/-components/editable-field";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { PropertyPopover } from "@/routes/_protected.workspaces/$workspaceId/-components/property-popover";
import type { TableColumnDef } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { useRetryCell } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-retry-cell";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type PropertyColumnOptions = {
  filters: ViewFilterCondition[];
};

export const getPropertyColumn = ({
  filters,
  property,
}: PropertyColumnOptions & {
  property: WorkspaceProperty;
}): TableColumnDef => ({
  id: property.id,
  accessorKey: property.id,
  accessorFn: (row) => row.fields[property.id],
  header: (ctx) => (
    <PropertyPopover
      filters={filters}
      header={ctx.header}
      property={property}
    />
  ),
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
  // Coordinated with the CellMetadataFlags child via the shared
  // override store, so both calls land on the same in-flight patch.
  // setLocked lets us latch an AI cell the moment the user commits
  // a manual edit — see the AI-model branch below.
  const { setLocked } = useCellMetadataFlags({
    workspaceId: property.workspaceId,
    entityId: entity.entityId,
    propertyId: property.id,
    metadata: cellMetadata,
  });

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

    // When the justification references a specific file, look it up
    // so label, mimeType, and the owning propertyId all match the
    // file the AI cited. Entries (not values) because the Record key
    // is the propertyId — that's the identifier downstream consumers
    // (edit-session, desktop-open) want on the inspector tab.
    const referencedFileEntry =
      justFieldId !== undefined
        ? Object.entries(entity.fields).find(
            ([, f]) => f.id === justFieldId && f.content.type === "file",
          )
        : undefined;
    const referencedFile = referencedFileEntry?.[1];
    const referencedFilePropertyId = referencedFileEntry?.[0];

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
    // The inspector tab's propertyId must point at the FILE property
    // (the one whose content is the DOCX/PDF), not the AI-extraction
    // property whose cell triggered the open. Downstream consumers —
    // DocxBrowserEditor's edit-session, the desktop-open button, and
    // inspector-panel's latestFileFieldForProperty lookup — all index
    // by the file's propertyId. Using the AI property here makes the
    // backend reject the open with "Target property is not an
    // editable DOCX field". The AI cell's identity travels via
    // justificationFieldId, which is what the source bar reads.
    const filePropertyId = referencedFilePropertyId ?? firstFile?.propertyId;

    if (fileFieldId && filePropertyId) {
      return (
        <WithOpenEntityButton
          entityId={entity.entityId}
          fieldId={fileFieldId}
          justificationFieldId={field.id}
          label={fileName}
          mimeType={mimeType}
          pdfFileId={pdfFileId}
          propertyId={filePropertyId}
          retryDisabled={cellMetadata?.locked === true || entity.readOnly}
          workspaceId={property.workspaceId}
        >
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
            onManualSave={() => setLocked(true)}
            property={property}
            propertyId={property.id}
            showDateIcon={false}
            workspaceId={property.workspaceId}
          />
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
};

type WithOpenEntityButtonProps = {
  fieldId: string;
  entityId: string;
  justificationFieldId: string;
  label: string;
  mimeType?: string | undefined;
  pdfFileId?: string | null | undefined;
  propertyId: string;
  retryDisabled: boolean;
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
  retryDisabled,
  workspaceId,
  children,
}: PropsWithChildren<WithOpenEntityButtonProps>) => {
  const t = useTranslations();
  const openFile = useInspectorStore((s) => s.openFile);
  const isFileAlreadyOpen = useInspectorStore((s) =>
    s.tabs.some((tab) => tab.type === "pdf" && tab.id === fieldId),
  );
  const retryCell = useRetryCell(workspaceId);
  const [isRetrying, setIsRetrying] = useState(false);

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

  // If the file is ALREADY open in the inspector and the user clicks
  // anywhere in this cell, push this cell's justification onto the
  // open tab so the source bar + folio highlight come up without
  // making the user hunt for the inline Náhled button. Skipped when
  // the file isn't open — opening unrelated files on every cell click
  // would be far more disruptive than the current "just expand".
  const handleCellClick = (event: React.MouseEvent) => {
    if (!isFileAlreadyOpen) {
      return;
    }
    // Don't fire when the user is clicking an interactive child
    // (editable field input, action button, etc.) — those have
    // their own click semantics that the inspector update would
    // step on. Same predicate the row-expansion handler uses.
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "button, a, input, textarea, select, [role='button'], [role='checkbox'], [data-row-expansion-ignore], [data-slot='select-trigger']",
      )
    ) {
      return;
    }
    handleOpenPreview();
  };

  const handleRetry = async () => {
    if (isRetrying) {
      return;
    }
    setIsRetrying(true);
    try {
      await retryCell({ entityId, propertyId });
    } finally {
      setIsRetrying(false);
    }
  };

  const inlineActionClass =
    "text-foreground-ghost hover:text-foreground hidden h-6 gap-1 px-1.5 text-xs opacity-70 group-data-[expanded-cell]/cell-content:flex hover:opacity-100";

  return (
    // The wrapper onClick is a click-only enhancement: when the
    // referenced file is already open in the inspector, clicking
    // anywhere in the cell pushes that cell's justification onto
    // the open tab. Keyboard users have a fully equivalent path via
    // the inline Preview button rendered below.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- see comment above
    <div className="w-full min-w-0 text-start" onClick={handleCellClick}>
      {children}
      <div
        className="absolute end-1.5 bottom-1.5 hidden items-center gap-1 group-data-[expanded-cell]/cell-content:flex"
        data-row-expansion-ignore
      >
        <Button
          className={inlineActionClass}
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
        <Button
          className={inlineActionClass}
          disabled={retryDisabled || isRetrying}
          onClick={(event) => {
            event.stopPropagation();
            void handleRetry();
          }}
          size="xs"
          variant="ghost"
        >
          <RefreshCwIcon className="size-3.5" />
          {t("common.retry")}
        </Button>
      </div>
    </div>
  );
};
