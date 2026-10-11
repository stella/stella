import type { legalReaderAnnotations } from "@/api/db/schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type PrivateAnnotationExportRow = Pick<
  typeof legalReaderAnnotations.$inferSelect,
  | "id"
  | "targetType"
  | "targetId"
  | "groupId"
  | "kind"
  | "visibility"
  | "color"
  | "style"
  | "blockAnchorId"
  | "startOffset"
  | "endOffset"
  | "quote"
  | "body"
  | "createdAt"
  | "updatedAt"
>;

/** A user's private notes only; shared annotations remain organization data. */
export const projectPrivateAnnotationForAccountExport = (
  row: PrivateAnnotationExportRow,
) => {
  if (row.visibility !== "private") {
    return undefined;
  }
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    groupId: row.groupId,
    kind: row.kind,
    visibility: row.visibility,
    color: row.color,
    style: row.style,
    blockAnchorId: row.blockAnchorId,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    quote: row.quote,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};

type LegalReaderAnnotationRow = typeof legalReaderAnnotations.$inferSelect;
type PrivateAnnotationAccountExport = NonNullable<
  ReturnType<typeof projectPrivateAnnotationForAccountExport>
>;

// Columns intentionally left out of the account export.
const UNEXPORTED_LEGAL_READER_ANNOTATION_COLUMNS = [
  // Tenant id: internal routing, not data the user provided.
  "organizationId",
  // The exporting account itself; every exported note is its own.
  "userId",
] as const satisfies readonly (keyof LegalReaderAnnotationRow)[];

// Totality guard, bidirectional: every schema column must be exported or
// explicitly excused above, and the export cannot carry a field that traces
// back to no real column.
type MissingExportedLegalReaderAnnotationColumn = UnprojectedColumns<
  LegalReaderAnnotationRow,
  PrivateAnnotationAccountExport,
  (typeof UNEXPORTED_LEGAL_READER_ANNOTATION_COLUMNS)[number]
>;
type UnexpectedExportedLegalReaderAnnotationColumn = UnbackedProjectionKeys<
  LegalReaderAnnotationRow,
  PrivateAnnotationAccountExport,
  (typeof UNEXPORTED_LEGAL_READER_ANNOTATION_COLUMNS)[number]
>;

true satisfies MissingExportedLegalReaderAnnotationColumn extends never
  ? true
  : never;
true satisfies UnexpectedExportedLegalReaderAnnotationColumn extends never
  ? true
  : never;
