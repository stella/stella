import { BidiText } from "@stll/ui/components/bidi-text";

import Tooltip from "@/components/tooltip";
import { isFileDisplayable } from "@/lib/types";
import type { WorkspaceField, WorkspaceProperty } from "@/lib/types";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { FieldValue } from "@/routes/_protected.workspaces/$workspaceId/-components/field-value";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

type CellResultProps = {
  extractionPreview?: string | null;
  field: WorkspaceField | undefined;
  property: WorkspaceProperty;
};

export const CellResult = ({
  extractionPreview,
  field,
  property,
}: CellResultProps) => {
  if (!field) {
    return null;
  }

  const type = field.content.type;

  if (type === "file") {
    return (
      <FileCell
        encrypted={field.content.encrypted}
        entityId={field.entityId}
        fieldId={field.id}
        fileName={field.content.fileName}
        mimeType={field.content.mimeType}
        pdfFileId={field.content.pdfFileId ?? null}
        propertyId={property.id}
        workspaceId={property.workspaceId}
      />
    );
  }

  return (
    <FieldValue
      content={field.content}
      pendingPreview={extractionPreview}
      property={property}
      variant="table"
    />
  );
};

type FileCellProps = {
  fileName: string;
  mimeType: string;
  fieldId: string;
  entityId: string;
  encrypted: boolean;
  pdfFileId: string | null;
  propertyId: string;
  workspaceId: string;
};

const FileCell = ({
  fileName,
  mimeType,
  fieldId,
  entityId,
  encrypted,
  pdfFileId,
  workspaceId,
  propertyId,
}: FileCellProps) => {
  const isDisplayable = isFileDisplayable({
    mimeType,
    fileName,
    pdfFileId,
    encrypted,
  });
  const openFile = useInspectorStore((s) => s.openFile);

  if (isDisplayable) {
    return (
      <Tooltip
        content={fileName}
        render={
          <button
            className="bg-muted grid max-w-full min-w-0 cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-center gap-1 rounded px-1 py-0.5 text-start"
            onClick={() =>
              openFile({
                id: fieldId,
                entityId,
                label: fileName,
                fileName,
                workspaceId,
                mimeType,
                pdfFileId,
                propertyId,
              })
            }
            type="button"
          />
        }
      >
        <DocumentIcon
          className="size-3.5 shrink-0"
          fileName={fileName}
          mimeType={mimeType}
        />
        <BidiText as="span" className="min-w-0 truncate text-start">
          {fileName}
        </BidiText>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      content={fileName}
      render={
        <span className="bg-muted grid max-w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-1 rounded px-1 py-0.5 text-start opacity-60" />
      }
    >
      <DocumentIcon
        className="size-3.5 shrink-0"
        fileName={fileName}
        mimeType={mimeType}
      />
      <BidiText as="span" className="min-w-0 truncate text-start">
        {fileName}
      </BidiText>
    </Tooltip>
  );
};
