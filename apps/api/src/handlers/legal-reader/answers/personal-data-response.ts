import type {
  legalReaderAnswerMessages,
  legalReaderAnswers,
} from "@/api/db/schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type AnswerExportRow = typeof legalReaderAnswers.$inferSelect;
type AnswerMessageExportRow = typeof legalReaderAnswerMessages.$inferSelect;

/**
 * A user's private reader questions only. Generated answers, citations and
 * model metadata are assistant output, which the account export excludes as
 * it does for chat; shared answers remain organization data.
 */
export const projectPrivateReaderAnswerForAccountExport = (
  row: AnswerExportRow,
  messages: readonly AnswerMessageExportRow[],
) => {
  if (row.visibility !== "private" || row.deletedAt !== null) {
    return undefined;
  }
  return {
    id: row.id,
    decisionId: row.decisionId,
    kind: row.kind,
    visibility: row.visibility,
    paragraphId: row.paragraphId,
    quote: row.quote,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    continuationSpans: row.continuationSpans,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    questions: messages
      .filter(({ role }) => role === "user")
      .map((message) => ({
        id: message.id,
        sequence: message.sequence,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      })),
  };
};

type PrivateReaderAnswerAccountExport = NonNullable<
  ReturnType<typeof projectPrivateReaderAnswerForAccountExport>
>;

// Columns intentionally left out of the account export.
const UNEXPORTED_LEGAL_READER_ANSWER_COLUMNS = [
  // Tenant id: internal routing, not data the user provided.
  "organizationId",
  // The exporting account itself; every exported answer is its own.
  "userId",
  // Deleted answers are never exported; the marker is internal state.
  "deletedAt",
] as const satisfies readonly (keyof AnswerExportRow)[];

// `questions` is the authored view of the message rows, not a column.
type MissingExportedReaderAnswerColumn = UnprojectedColumns<
  AnswerExportRow,
  PrivateReaderAnswerAccountExport,
  (typeof UNEXPORTED_LEGAL_READER_ANSWER_COLUMNS)[number]
>;
type UnexpectedExportedReaderAnswerColumn = UnbackedProjectionKeys<
  AnswerExportRow,
  Omit<PrivateReaderAnswerAccountExport, "questions">,
  (typeof UNEXPORTED_LEGAL_READER_ANSWER_COLUMNS)[number]
>;

true satisfies MissingExportedReaderAnswerColumn extends never ? true : never;
true satisfies UnexpectedExportedReaderAnswerColumn extends never
  ? true
  : never;
