import { DOCX_MIME, getNativeOfficeViewerFormat, PDF_MIME } from "@/lib/consts";

export const FILE_OPEN_TARGET = {
  /** The full-screen `/workspaces/$workspaceId/$viewId/document` route. */
  documentRoute: "document-route",
  /** The matter view with the file opened in the inspector. */
  workspaceInspector: "workspace-inspector",
} as const;

export type FileOpenTarget =
  (typeof FILE_OPEN_TARGET)[keyof typeof FILE_OPEN_TARGET];

/**
 * Where a file whose MIME type is the only thing known can open full-screen.
 *
 * The document route renders exactly PDF, DOCX, and the native office
 * formats from the MIME alone; every other format there falls into the PDF
 * viewer, whose display-purpose file fetch the server rejects (emails were
 * the incident: a 400 into the PDF error boundary). A PDF twin can widen
 * what the route renders, but a caller that only knows the MIME cannot rely
 * on one existing, so everything else opens inside its matter via the
 * inspector, which handles any file (email HTML viewer, markdown, metadata
 * plus download as the floor).
 *
 * Every surface that opens a file from a MIME-only context (search results,
 * recent files) must route through this dispatch instead of assuming the
 * document route, so a new surface cannot reintroduce the class.
 */
export const resolveFileOpenTarget = (
  mimeType: string | null,
): FileOpenTarget => {
  if (mimeType === null) {
    return FILE_OPEN_TARGET.workspaceInspector;
  }
  const rendersFullScreenFromMime =
    mimeType === PDF_MIME ||
    mimeType === DOCX_MIME ||
    getNativeOfficeViewerFormat(mimeType) !== null;
  return rendersFullScreenFromMime
    ? FILE_OPEN_TARGET.documentRoute
    : FILE_OPEN_TARGET.workspaceInspector;
};
