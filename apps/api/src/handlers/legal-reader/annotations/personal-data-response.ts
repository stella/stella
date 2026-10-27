import { READER_MATTER_TARGET_TYPES } from "@stll/api-contract/legal-reader-annotations";

import type { legalReaderAnnotations } from "@/api/db/schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type PrivateAnnotationExportRow = Pick<
  typeof legalReaderAnnotations.$inferSelect,
  | "id"
  | "userId"
  | "targetType"
  | "targetId"
  | "workspaceId"
  | "verificationRunId"
  | "verificationClaimId"
  | "entityId"
  | "pageTextSha256"
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

const MATTER_TARGET_TYPES: ReadonlySet<string> = new Set(
  READER_MATTER_TARGET_TYPES,
);

/**
 * A user's private public-law notes and all of their notes on matter content
 * (verification-claim comments, matter document marks). Shared public-law
 * annotations remain organization data, while the words a user wrote on a
 * matter remain part of the author's personal-data export.
 */
export const projectPrivateAnnotationForAccountExport = (
  row: PrivateAnnotationExportRow,
) => {
  if (
    row.visibility !== "private" &&
    !MATTER_TARGET_TYPES.has(row.targetType)
  ) {
    return undefined;
  }
  return {
    id: row.id,
    userId: row.userId,
    targetType: row.targetType,
    targetId: row.targetId,
    workspaceId: row.workspaceId,
    verificationRunId: row.verificationRunId,
    verificationClaimId: row.verificationClaimId,
    entityId: row.entityId,
    pageTextSha256: row.pageTextSha256,
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
