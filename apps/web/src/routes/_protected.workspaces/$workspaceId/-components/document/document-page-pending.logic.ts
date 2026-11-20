import type { QueryClient } from "@tanstack/react-query";

import { DOCUMENT_PANE } from "@/components/inspector/document-pane";
import { newestCachedData } from "@/components/pending-cache-reads.logic";
import { DOCX_MIME, getNativeOfficeViewerFormat, PDF_MIME } from "@/lib/consts";
import { fileMetadataQueryKey } from "@/lib/files/file-metadata-query.logic";
import { PDF_COLOR_MODES } from "@/lib/pdf/pdf-color-mode";
import type { PDFColorMode } from "@/lib/pdf/pdf-color-mode";
import type { EntityField } from "@/lib/types";
import {
  entityDetailKey,
  entityVersionsRootKey,
} from "@/lib/workspaces/queries/entity-keys.logic";
import type { EntityVersion } from "@/lib/workspaces/queries/entity-versions";

/**
 * What the document page will draw for the file it opens, as far as the
 * cache can say before the page loads:
 * - `docx`: a Word document, drawn on the DOCX sheet with its toolbar in the
 *   editor's own bar;
 * - `office`: a spreadsheet or a presentation, drawn by the office viewer on
 *   the same sheet while it loads;
 * - `pdf`: everything else, which the PDF viewer draws under the page's
 *   toolbar row;
 * - `unknown`: the cache does not hold the file, or the page will draw a
 *   pane whose shape depends on loaded data (a review, the page organizer).
 */
export type DocumentPageSheet =
  | { type: "docx" }
  | { type: "office" }
  | {
      type: "pdf";
      /** The colour mode its toolbar control shows; `undefined` without it. */
      colorMode: PDFColorMode | undefined;
    }
  | { type: "unknown" };

const UNKNOWN: DocumentPageSheet = { type: "unknown" };

/** The part of the entity page's entity the sheet is chosen from. */
type CachedDocumentEntity = { fields: readonly EntityField[] };

/**
 * What the cache holds under an entity's version-history key: a page of the
 * history (`entityVersionsOptions`), or one field's file looked up on its
 * own (`fieldFileOptions`, keyed by the field id last).
 */
type CachedVersionRead =
  | { versions: readonly EntityVersion[] }
  | { file: Pick<NonNullable<EntityVersion["file"]>, "mimeType"> | null };

/** The search the document page reads its pane from. */
export type DocumentPageSearch = {
  entity?: string | undefined;
  field?: string | undefined;
  pane?: string | undefined;
  pdfMode?: string | undefined;
  pdfColorMode?: string | undefined;
};

const cachedFileMimeType = (
  queryClient: QueryClient,
  {
    entityId,
    fieldId,
    workspaceId,
  }: { entityId: string; fieldId: string; workspaceId: string },
): string | undefined => {
  const entity = newestCachedData(
    queryClient,
    queryClient.getQueriesData<CachedDocumentEntity>({
      exact: true,
      queryKey: entityDetailKey(workspaceId, entityId),
    }),
  );
  const field = entity?.fields.find((candidate) => candidate.id === fieldId);
  if (field !== undefined) {
    return field.content.type === "file" ? field.content.mimeType : undefined;
  }
  // An older version's file is not among the entity's current fields; the
  // page finds it in the version history (or, past its first page, by the
  // field's own lookup, cached under the same key), and so does its loading
  // view.
  const reads = queryClient.getQueriesData<CachedVersionRead>({
    queryKey: entityVersionsRootKey(workspaceId, entityId),
  });
  for (const [queryKey, read] of reads) {
    if (read === undefined) {
      continue;
    }
    if ("versions" in read) {
      const file = read.versions.find(
        (version) => version.file?.fieldId === fieldId,
      )?.file;
      if (file) {
        return file.mimeType;
      }
    } else if (queryKey.at(-1) === fieldId && read.file !== null) {
      return read.file.mimeType;
    }
  }
  return undefined;
};

// The colour-mode control sits in the PDF toolbar for a PDF that was not
// made from an image; its file's metadata says which. Without it cached, a
// PDF is taken to be one the control applies to, which most are.
const pdfColorControl = (
  queryClient: QueryClient,
  { fieldId, workspaceId }: { fieldId: string; workspaceId: string },
): boolean => {
  const metadata = newestCachedData(
    queryClient,
    queryClient.getQueriesData<{ originalMimeType: string }>({
      exact: true,
      queryKey: fileMetadataQueryKey({ fieldId, workspaceId }),
    }),
  );
  return (
    metadata === undefined || !metadata.originalMimeType.startsWith("image/")
  );
};

/**
 * The sheet the document page draws for the file the URL opens, read from
 * the cached entity, by the rules the page itself decides with.
 */
export const cachedDocumentPageSheet = (
  queryClient: QueryClient | null,
  workspaceId: string | undefined,
  search: DocumentPageSearch,
): DocumentPageSheet => {
  const { entity: entityId, field: fieldId } = search;
  if (
    queryClient === null ||
    workspaceId === undefined ||
    entityId === undefined ||
    fieldId === undefined
  ) {
    return UNKNOWN;
  }
  const mimeType = cachedFileMimeType(queryClient, {
    entityId,
    fieldId,
    workspaceId,
  });
  if (mimeType === undefined) {
    return UNKNOWN;
  }
  if (mimeType === DOCX_MIME) {
    return search.pane === DOCUMENT_PANE.review ? UNKNOWN : { type: "docx" };
  }
  if (getNativeOfficeViewerFormat(mimeType) !== null) {
    return { type: "office" };
  }
  if (mimeType === PDF_MIME && search.pdfMode === "organize") {
    return UNKNOWN;
  }
  const colorControl =
    !mimeType.startsWith("image/") &&
    pdfColorControl(queryClient, { fieldId, workspaceId });
  return {
    type: "pdf",
    colorMode: colorControl
      ? (PDF_COLOR_MODES.find((mode) => mode === search.pdfColorMode) ??
        "system")
      : undefined,
  };
};
