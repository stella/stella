import { Result } from "better-result";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type * as v from "valibot";

import { READER_ANSWER_MAX_MESSAGES } from "@stll/api-contract/reader-answers";
import type { ReaderAnswer } from "@stll/api-contract/reader-answers";

import { legalReaderAnswerMessages, legalReaderAnswers } from "@/api/db/schema";
import { readerAnswerSpansOf } from "@/api/handlers/legal-reader/answers/operation";
import { listAnswersQuerySchema } from "@/api/handlers/legal-reader/answers/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { AnnotationAuthorScope } from "@/api/lib/legal-search/reader-annotations/target";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import {
  brandPersistedLegalReaderAnswerId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    "List your reader answers and the answers colleagues explicitly shared on a decision.",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  access: "read",
  query: listAnswersQuerySchema,
} satisfies HandlerConfig;
const cursorCodec = createTimestampIdCursorCodec({
  column: legalReaderAnswers.createdAt,
  brandId: brandPersistedLegalReaderAnswerId,
});

const ANSWER_PROJECTION = {
  id: legalReaderAnswers.id,
  userId: legalReaderAnswers.userId,
  decisionId: legalReaderAnswers.decisionId,
  kind: legalReaderAnswers.kind,
  visibility: legalReaderAnswers.visibility,
  paragraphId: legalReaderAnswers.paragraphId,
  quote: legalReaderAnswers.quote,
  startOffset: legalReaderAnswers.startOffset,
  endOffset: legalReaderAnswers.endOffset,
  continuationSpans: legalReaderAnswers.continuationSpans,
  createdAt: legalReaderAnswers.createdAt,
  updatedAt: legalReaderAnswers.updatedAt,
} as const;

const MESSAGE_PROJECTION = {
  id: legalReaderAnswerMessages.id,
  answerId: legalReaderAnswerMessages.answerId,
  role: legalReaderAnswerMessages.role,
  content: legalReaderAnswerMessages.content,
  citations: legalReaderAnswerMessages.citations,
  model: legalReaderAnswerMessages.model,
  usage: legalReaderAnswerMessages.usage,
  status: legalReaderAnswerMessages.status,
  errorCode: legalReaderAnswerMessages.errorCode,
  invalidCitationCount: legalReaderAnswerMessages.invalidCitationCount,
  createdAt: legalReaderAnswerMessages.createdAt,
  updatedAt: legalReaderAnswerMessages.updatedAt,
} as const;

type AnswerRow = typeof legalReaderAnswers.$inferSelect;
const UNPROJECTED_ANSWER_COLUMNS = [
  // The authenticated organization is fixed by both the query and RLS.
  "organizationId",
  // Deleted threads are filtered from the reader's list.
  "deletedAt",
] as const satisfies readonly (keyof AnswerRow)[];

type MissingAnswerColumn = UnprojectedColumns<
  AnswerRow,
  typeof ANSWER_PROJECTION,
  (typeof UNPROJECTED_ANSWER_COLUMNS)[number]
>;
type UnexpectedAnswerColumn = UnbackedProjectionKeys<
  AnswerRow,
  typeof ANSWER_PROJECTION,
  (typeof UNPROJECTED_ANSWER_COLUMNS)[number]
>;
const UNPROJECTED_MESSAGE_COLUMNS = [
  // Sequence orders the returned array without exposing storage positions.
  "sequence",
] as const satisfies readonly (keyof typeof legalReaderAnswerMessages.$inferSelect)[];
type MissingMessageColumn = UnprojectedColumns<
  typeof legalReaderAnswerMessages.$inferSelect,
  typeof MESSAGE_PROJECTION,
  (typeof UNPROJECTED_MESSAGE_COLUMNS)[number]
>;
type UnexpectedMessageColumn = UnbackedProjectionKeys<
  typeof legalReaderAnswerMessages.$inferSelect,
  typeof MESSAGE_PROJECTION,
  (typeof UNPROJECTED_MESSAGE_COLUMNS)[number]
>;

true satisfies MissingAnswerColumn extends never ? true : never;
true satisfies UnexpectedAnswerColumn extends never ? true : never;
true satisfies MissingMessageColumn extends never ? true : never;
true satisfies UnexpectedMessageColumn extends never ? true : never;

type ListReaderAnswersOptions = Omit<
  AnnotationAuthorScope,
  "recordAuditEvent"
> & { query: v.InferOutput<typeof listAnswersQuerySchema> };
export const listReaderAnswersHandler = async function* ({
  query,
  organizationId,
  userId,
  safeDb,
  readCopies = readWithdrawnCopyProjection,
}: ListReaderAnswersOptions) {
  const limit = normalizeTenantPageLimit(query.limit ?? 20);
  const conditions = [
    eq(legalReaderAnswers.organizationId, organizationId),
    eq(legalReaderAnswers.decisionId, query.decisionId),
    isNull(legalReaderAnswers.deletedAt),
    or(
      eq(legalReaderAnswers.userId, userId),
      eq(legalReaderAnswers.visibility, "shared"),
    ),
  ];
  if (query.cursor !== undefined) {
    const cursor = cursorCodec.decode(query.cursor);
    if (cursor === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    conditions.push(
      cursorCodec.keysetAfter({
        cursor,
        direction: "ascending",
        idColumn: legalReaderAnswers.id,
      }),
    );
  }
  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          answer: ANSWER_PROJECTION,
          createdAtCursor: cursorCodec.cursorValue.as("created_at_cursor"),
        })
        .from(legalReaderAnswers)
        .where(and(...conditions))
        .orderBy(asc(legalReaderAnswers.createdAt), asc(legalReaderAnswers.id))
        .limit(limit + 1),
    ),
  );
  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: ({ answer, createdAtCursor }) =>
      cursorCodec.encode(createdAtCursor, answer.id),
  });
  const ids = page.items.map(({ answer }) => answer.id);
  const messages =
    ids.length === 0
      ? []
      : yield* Result.await(
          safeDb((tx) =>
            tx
              .select({ message: MESSAGE_PROJECTION })
              .from(legalReaderAnswerMessages)
              .innerJoin(
                legalReaderAnswers,
                and(
                  eq(legalReaderAnswers.id, legalReaderAnswerMessages.answerId),
                  eq(legalReaderAnswers.organizationId, organizationId),
                ),
              )
              .where(inArray(legalReaderAnswerMessages.answerId, ids))
              .orderBy(
                asc(legalReaderAnswerMessages.answerId),
                asc(legalReaderAnswerMessages.sequence),
              )
              .limit(limit * READER_ANSWER_MAX_MESSAGES),
          ),
        );
  const projection = yield* Result.await(
    Result.tryPromise(async () =>
      readCopies({ values: [page.items, messages] }),
    ),
  );
  const items = page.items.map(({ answer: storedAnswer }): ReaderAnswer => {
    const answer = projection.answer(storedAnswer);
    return {
      id: answer.id,
      decisionId: answer.decisionId,
      authorId: brandPersistedUserId(answer.userId),
      mine: answer.userId === userId,
      kind: answer.kind,
      visibility: answer.visibility,
      anchor: { spans: readerAnswerSpansOf(answer) },
      createdAt: answer.createdAt.toISOString(),
      updatedAt: answer.updatedAt.toISOString(),
      messages: messages
        .filter(({ message }) => message.answerId === answer.id)
        .map(({ message: storedMessage }) => {
          const message = projection.answerMessage(
            storedMessage,
            answer.decisionId,
          );
          return {
            id: message.id,
            role: message.role,
            content: message.content,
            citations: message.citations,
            model: message.model,
            usage: message.usage,
            status: message.status,
            errorCode: message.errorCode,
            invalidCitationCount: message.invalidCitationCount,
            createdAt: message.createdAt.toISOString(),
            updatedAt: message.updatedAt.toISOString(),
          };
        }),
    };
  });
  return Result.ok({ items, nextCursor: page.nextCursor, limit: page.limit });
};

const listReaderAnswers = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session, user }) {
    return yield* listReaderAnswersHandler({
      query,
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
    });
  },
);
export default listReaderAnswers;
