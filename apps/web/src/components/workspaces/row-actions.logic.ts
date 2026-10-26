import { panic, Result } from "better-result";

import { ENTITY_NAME_MAX_LENGTH, truncateEntityName } from "@stll/api-contract";

import {
  type CopyToMatterEntity,
  getCopyToMatterRootEntities,
} from "@/components/workspaces/copy-to-matter-dialog.logic";
import type { WorkspaceEntityColumnRender } from "@/components/workspaces/table/table-schema";
import { PDF_MIME_TYPE } from "@/consts";
import type {
  FieldId,
  OcrExportStatus,
  PropertyId,
  WorkspaceEntity,
} from "@/lib/types";

export type OcrSource = {
  encrypted: boolean;
  exportStatus: OcrExportStatus;
  fieldId: FieldId;
  fileName: string;
  mimeType: string;
};

export type RowActionContext = "bulk" | "cell" | "row";
export type OcrExportFormat = "searchable-pdf" | "text";

/**
 * What right-clicking a table cell opens. A `row` column is the row's handle
 * (the select gutter, a list item's name) and opens the row's menu; a `cell`
 * column holds a property value and opens that cell's menu; a `native` column
 * shows a value no menu action applies to, so the browser's own menu (copy,
 * look up) stays.
 */
export type ColumnContextMenu = "cell" | "native" | "row";

export const COLUMN_CONTEXT_MENU = {
  select: "row",
  "add-property": "row",
  name: "row",
  "list-item-type": "native",
  "task-status": "native",
  "task-priority": "native",
  "task-due-date": "native",
  "created-by": "native",
  "updated-at": "native",
  version: "native",
  property: "cell",
} as const satisfies Record<
  WorkspaceEntityColumnRender["type"],
  ColumnContextMenu
>;

/**
 * What a row menu acts on: the row (its ⋮ trigger or handle), a bulk
 * selection, the cell holding the file the row's file actions act on, another
 * file cell, or a cell holding any other value.
 */
export type RowMenuSubject =
  "bulk" | "file-cell" | "row" | "row-file-cell" | "value-cell";

type ResolveRowMenuSubjectOptions = {
  cellPropertyId: PropertyId | null;
  fields: WorkspaceEntity["fields"];
  isBulk: boolean;
  rowFilePropertyId: PropertyId | null;
};

export const resolveRowMenuSubject = ({
  cellPropertyId,
  fields,
  isBulk,
  rowFilePropertyId,
}: ResolveRowMenuSubjectOptions): RowMenuSubject => {
  if (isBulk) {
    return "bulk";
  }
  if (cellPropertyId === null) {
    return "row";
  }
  if (fields[cellPropertyId]?.content.type !== "file") {
    return "value-cell";
  }
  return cellPropertyId === rowFilePropertyId ? "row-file-cell" : "file-cell";
};

export type RowMenuSection =
  | "cell-ocr-export"
  | "cell-review"
  | "chat"
  | "desktop-edit"
  | "edit-pages"
  | "file-operations"
  | "new-folder-from-selection"
  | "new-subfolder"
  | "open"
  | "preview"
  | "rename"
  | "run-ocr"
  | "sign"
  | "translate"
  | "upload-version";

// Every action on the row's file or entity. `cell-review` (retry, lock, flags)
// is a property's, so a cell offers it and the row does not.
const ROW_FILE_SECTIONS = [
  "preview",
  "upload-version",
  "run-ocr",
  "desktop-edit",
  "open",
  "edit-pages",
  "sign",
  "chat",
  "translate",
  "file-operations",
] satisfies readonly RowMenuSection[];

const ROW_SECTIONS = [
  ...ROW_FILE_SECTIONS,
  "rename",
  "new-subfolder",
] satisfies readonly RowMenuSection[];

/**
 * The sections a row menu may show for each subject; each section still hides
 * itself when it does not apply to the entity (no file, read-only, …). A cell
 * offers only what acts on that cell: file actions belong to the row and the
 * cell holding the row's file, and another file cell keeps the actions that
 * take its own file.
 */
export const ROW_MENU_SECTIONS = {
  row: ROW_SECTIONS,
  bulk: [...ROW_SECTIONS, "new-folder-from-selection"],
  "row-file-cell": [...ROW_FILE_SECTIONS, "cell-review"],
  "file-cell": [
    "run-ocr",
    "edit-pages",
    "translate",
    "cell-ocr-export",
    "cell-review",
  ],
  "value-cell": ["cell-review"],
} as const satisfies Record<RowMenuSubject, readonly RowMenuSection[]>;

export const getRowMenuSections = (
  subject: RowMenuSubject,
): ReadonlySet<RowMenuSection> => new Set(ROW_MENU_SECTIONS[subject]);

export const ROW_MENU_ACTION_CONTEXT = {
  row: "row",
  bulk: "bulk",
  "row-file-cell": "row",
  "file-cell": "cell",
  "value-cell": "cell",
} as const satisfies Record<RowMenuSubject, RowActionContext>;

/**
 * The searchable PDF is a stored derivative that can lag or fail behind the
 * text, so an export offer is per format rather than per source.
 */
export const getOcrExportFormats = (
  exportStatus: OcrExportStatus,
): readonly OcrExportFormat[] => {
  switch (exportStatus) {
    case "text-and-pdf":
      return ["searchable-pdf", "text"];
    case "text":
      return ["text"];
    case "unavailable":
      return [];
    default:
      exportStatus satisfies never;
      return panic(`Unhandled export status: ${String(exportStatus)}`);
  }
};

export const hasOcrExport = (source: OcrSource): boolean =>
  getOcrExportFormats(source.exportStatus).length > 0;

type GetOcrSourceInput = {
  fields: WorkspaceEntity["fields"];
  propertyId: PropertyId | null | undefined;
};

// OCR is scoped to the file field the user selected. Do not fall back to the
// first entity file: entities can have multiple file fields with distinct
// documents and access expectations.
export const getOcrSource = ({
  fields,
  propertyId,
}: GetOcrSourceInput): OcrSource | null => {
  if (propertyId === null || propertyId === undefined) {
    return null;
  }

  const field = fields[propertyId];
  if (!field || field.content.type !== "file") {
    return null;
  }

  return {
    encrypted: field.content.encrypted,
    exportStatus: field.ocrExportStatus ?? "unavailable",
    fieldId: field.id,
    fileName: field.content.fileName,
    mimeType: field.content.mimeType,
  };
};

export const getOcrSources = (fields: WorkspaceEntity["fields"]): OcrSource[] =>
  Object.values(fields).flatMap((field) => {
    if (!field || field.content.type !== "file") {
      return [];
    }
    return [
      {
        encrypted: field.content.encrypted,
        exportStatus: field.ocrExportStatus ?? "unavailable",
        fieldId: field.id,
        fileName: field.content.fileName,
        mimeType: field.content.mimeType,
      },
    ];
  });

type CanRunManualOcrInput = {
  context: RowActionContext;
  entity: Pick<WorkspaceEntity, "kind" | "readOnly">;
  ocrSource: OcrSource | undefined;
};

export const canRunManualOcr = ({
  context,
  entity,
  ocrSource,
}: CanRunManualOcrInput): boolean =>
  context !== "bulk" &&
  entity.kind !== "folder" &&
  !entity.readOnly &&
  ocrSource !== undefined &&
  !ocrSource.encrypted &&
  ocrSource.mimeType === PDF_MIME_TYPE;

export const getOcrExportFileName = (
  fileName: string,
  format: OcrExportFormat,
): string => {
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex <= 0 ? fileName : fileName.slice(0, dotIndex);
  return format === "searchable-pdf"
    ? `${baseName}-searchable.pdf`
    : `${baseName}.txt`;
};

type GetDuplicateNameOptions = {
  duplicateLabel: string;
  kind: WorkspaceEntity["kind"];
  name: string;
};

/** Keep a recognizable source name while preserving a document's final extension. */
export const getDuplicateName = ({
  duplicateLabel,
  kind,
  name,
}: GetDuplicateNameOptions): string => {
  const dotIndex = name.lastIndexOf(".");
  const hasExtension =
    kind === "document" && dotIndex > 0 && name.length - dotIndex <= 32;
  const extension = hasExtension ? name.slice(dotIndex) : "";
  const base = hasExtension ? name.slice(0, dotIndex) : name;
  const maxLabelLength = ENTITY_NAME_MAX_LENGTH - extension.length - 4;
  const label = truncateEntityName(duplicateLabel, Math.max(maxLabelLength, 0));
  const suffix = label ? ` (${label})` : "";
  const maxBaseLength =
    ENTITY_NAME_MAX_LENGTH - extension.length - suffix.length;
  return `${truncateEntityName(
    base,
    Math.max(maxBaseLength, 1),
  )}${suffix}${extension}`;
};

export const getDesktopEditLockState = (
  activeEditBy: { isMe: boolean } | null,
) => {
  if (!activeEditBy) {
    return "unlocked";
  }

  return activeEditBy.isMe ? "locked-by-me" : "locked-by-other";
};

/**
 * Asks the holder of a desktop edit lock to hand it over. `requestTakeover`
 * resolves true once the request reaches the holder, and false when there is
 * no one to ask (e.g. no active session); a thrown request is reported. In
 * both of the latter cases the takeover is forced; `forceTakeover` owns its
 * own failure feedback.
 */
export const requestDesktopEditTakeover = async ({
  requestTakeover,
  forceTakeover,
  awaitConsent,
  reportError,
}: {
  requestTakeover: () => Promise<boolean>;
  forceTakeover: () => Promise<void>;
  awaitConsent: () => void;
  reportError: (error: unknown) => void;
}): Promise<void> => {
  const requested = await Result.tryPromise({
    try: requestTakeover,
    catch: (cause) => cause,
  });
  if (Result.isError(requested)) {
    reportError(requested.error);
    await forceTakeover();
    return;
  }
  if (!requested.value) {
    await forceTakeover();
    return;
  }
  awaitConsent();
};

type FolderFromSelectionPlan = {
  entityIds: string[];
  parentId: string | null;
};

/**
 * Where a folder made from a selection goes and what moves into it. An entity
 * whose ancestor is also selected moves with that ancestor, so only the
 * top-level targets are sent. The folder goes to the deepest folder that
 * contains every target (their shared parent when they are siblings), or the
 * matter root when none does. A chain cut short by a missing lookup only loses
 * its upper ancestors, so the answer falls back to the root, never to a folder
 * that does not contain every target.
 */
export const planFolderFromSelection = (
  selection: readonly CopyToMatterEntity[],
): FolderFromSelectionPlan => {
  const targets = getCopyToMatterRootEntities(selection);
  const [first, ...rest] = targets;
  const parentId =
    first?.ancestorIds.find((ancestorId) =>
      rest.every((target) => target.ancestorIds.includes(ancestorId)),
    ) ?? null;
  return { entityIds: targets.map((target) => target.entityId), parentId };
};
