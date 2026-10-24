import { panic, Result } from "better-result";
import { and, asc, eq, getColumns, isNull } from "drizzle-orm";

import {
  READER_ANSWER_ANCHOR_MISMATCH_CODE,
  READER_ANSWER_DEADLINE_MS,
  READER_ANSWER_MAX_MESSAGES,
} from "@stll/api-contract/reader-answers";
import type {
  CreateReaderAnswer,
  ReaderAnswerAnchor,
  ReaderAnswerFollowUp,
  ReaderAnswerRegenerate,
} from "@stll/api-contract/reader-answers";

import type { Transaction } from "@/api/db/root";
import { abortableTx, abortTransaction } from "@/api/db/safe-db";
import { legalReaderAnswerMessages, legalReaderAnswers } from "@/api/db/schema";
import type { AnnotationAuthorScope } from "@/api/handlers/legal-reader/annotations/target";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { readReaderAnswerDecision } from "@/api/lib/case-law/reader-answer-corpus";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionScopedCount } from "@/api/lib/db/transitions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

/** Streaming updatedAt is the claim time; it never renews during admission or generation. */
export const readerAnswerDeadlineAt = (claimedAt: Date) =>
  claimedAt.getTime() + READER_ANSWER_DEADLINE_MS;

export const answerOwnerPredicate = ({
  answerId,
  organizationId,
  userId,
}: AnnotationAuthorScope & { answerId: SafeId<"legalReaderAnswer"> }) =>
  and(
    eq(legalReaderAnswers.id, answerId),
    eq(legalReaderAnswers.organizationId, organizationId),
    eq(legalReaderAnswers.userId, userId),
    isNull(legalReaderAnswers.deletedAt),
  );

export type ReaderAnswerCommand =
  | { type: "create"; body: CreateReaderAnswer }
  | {
      type: "follow-up";
      answerId: SafeId<"legalReaderAnswer">;
      body: ReaderAnswerFollowUp;
    }
  | {
      type: "regenerate";
      answerId: SafeId<"legalReaderAnswer">;
      body: ReaderAnswerRegenerate;
    };

export type PrepareReaderAnswerOptions = AnnotationAuthorScope & {
  command: ReaderAnswerCommand;
  readDecision?: typeof readReaderAnswerDecision;
};

const anchorOf = (answer: typeof legalReaderAnswers.$inferSelect) =>
  ({
    paragraphId: answer.paragraphId,
    quote: answer.quote,
    startOffset: answer.startOffset,
    endOffset: answer.endOffset,
  }) satisfies ReaderAnswerAnchor;

type AnswerAnchorRow = typeof legalReaderAnswers.$inferSelect;
const UNPROJECTED_ANCHOR_COLUMNS = [
  // Thread identity is returned separately in the stream's started event.
  "id",
  // Session-bound authorization belongs to the thread, not its passage.
  "organizationId",
  "userId",
  // The decision context is resolved separately from the passage coordinates.
  "decisionId",
  // Thread mode and sharing do not describe the selected characters.
  "kind",
  "visibility",
  // Thread lifecycle is carried by its row and checked before generation.
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const satisfies readonly (keyof AnswerAnchorRow)[];

type MissingAnchorColumn = UnprojectedColumns<
  AnswerAnchorRow,
  ReturnType<typeof anchorOf>,
  (typeof UNPROJECTED_ANCHOR_COLUMNS)[number]
>;
type UnexpectedAnchorColumn = UnbackedProjectionKeys<
  AnswerAnchorRow,
  ReturnType<typeof anchorOf>,
  (typeof UNPROJECTED_ANCHOR_COLUMNS)[number]
>;
true satisfies MissingAnchorColumn extends never ? true : never;
true satisfies UnexpectedAnchorColumn extends never ? true : never;

type RegenerateLastReaderAnswerOptions = {
  tx: Transaction;
  scope: AnnotationAuthorScope;
  answer: typeof legalReaderAnswers.$inferSelect;
  messages: (typeof legalReaderAnswerMessages.$inferSelect)[];
  now: Date;
};
const regenerateLastReaderAnswer = async ({
  tx,
  scope,
  answer,
  messages,
  now,
}: RegenerateLastReaderAnswerOptions) => {
  const answerId = answer.id;
  const last = messages.at(-1);
  if (last?.role !== "assistant") {
    return abortTransaction(
      new HandlerError({
        status: 409,
        message: "There is no assistant answer to regenerate",
      }),
    );
  }
  const messageId = createSafeId<"legalReaderAnswerMessage">();
  await tx
    .delete(legalReaderAnswerMessages)
    .where(
      and(
        eq(legalReaderAnswerMessages.answerId, answerId),
        eq(legalReaderAnswerMessages.id, last.id),
      ),
    );
  const inserted =
    (
      await tx
        .insert(legalReaderAnswerMessages)
        .values({
          id: messageId,
          answerId,
          sequence: last.sequence,
          role: "assistant",
          content: "",
          status: "streaming",
          createdAt: last.createdAt,
          updatedAt: now,
        })
        .returning({
          claimToken: timestampCasToken(legalReaderAnswerMessages.updatedAt),
          updatedAt: legalReaderAnswerMessages.updatedAt,
        })
    ).at(0) ??
    panic("Reader answer regeneration did not create its claimed message");
  await tx
    .update(legalReaderAnswers)
    .set({ updatedAt: now })
    .where(answerOwnerPredicate({ ...scope, answerId }));
  await scope.recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER,
    resourceId: answerId,
  });
  return {
    answer,
    messageId,
    history: messages.slice(0, -1),
    deadlineAt: readerAnswerDeadlineAt(inserted.updatedAt),
    claimToken: inserted.claimToken,
  };
};

/** Corpus I/O precedes the short parent-locked transaction claiming a turn. */
const readReaderAnswerContext = async ({
  command,
  readDecision = readReaderAnswerDecision,
  ...scope
}: PrepareReaderAnswerOptions) =>
  await Result.gen(async function* () {
    const existing =
      command.type === "create"
        ? undefined
        : yield* Result.await(
            scope.safeDb(async (tx) =>
              (
                await tx
                  .select()
                  .from(legalReaderAnswers)
                  .where(
                    answerOwnerPredicate({
                      ...scope,
                      answerId: command.answerId,
                    }),
                  )
                  .limit(1)
              ).at(0),
            ),
          );
    if (command.type !== "create" && existing === undefined) {
      return Result.err(
        new HandlerError({ status: 404, message: "Reader answer not found" }),
      );
    }
    const decisionId =
      command.type === "create"
        ? command.body.decisionId
        : existing?.decisionId;
    if (decisionId === undefined) {
      return Result.err(
        new HandlerError({ status: 404, message: "Reader answer not found" }),
      );
    }
    const decision = yield* Result.await(
      readDecision(decisionId).then((read) =>
        read.mapError(
          (cause) =>
            new HandlerError({
              status: 503,
              message: "Decision reader is unavailable",
              cause,
            }),
        ),
      ),
    );
    if (decision === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Decision unavailable for explanation",
        }),
      );
    }
    const anchor =
      command.type === "create"
        ? command.body.anchor
        : existing && anchorOf(existing);
    const paragraph = decision.paragraphs.find(
      ({ paragraphId }) => paragraphId === anchor?.paragraphId,
    );
    if (
      anchor === undefined ||
      paragraph === undefined ||
      anchor.startOffset < 0 ||
      anchor.endOffset > paragraph.text.length ||
      anchor.endOffset <= anchor.startOffset ||
      paragraph.text.slice(anchor.startOffset, anchor.endOffset) !==
        anchor.quote
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: READER_ANSWER_ANCHOR_MISMATCH_CODE,
          message: "Selection does not match the decision paragraph",
        }),
      );
    }
    const answerId =
      command.type === "create"
        ? createSafeId<"legalReaderAnswer">()
        : command.answerId;
    return Result.ok({ decision, anchor, answerId });
  });

/** A thread past the message cap is refused rather than read truncated. */
const readReaderAnswerThread = async (
  tx: Transaction,
  answerId: SafeId<"legalReaderAnswer">,
) => {
  const thread = await readBounded(
    tx
      .select()
      .from(legalReaderAnswerMessages)
      .where(eq(legalReaderAnswerMessages.answerId, answerId))
      .orderBy(asc(legalReaderAnswerMessages.sequence)),
    READER_ANSWER_MAX_MESSAGES,
  );
  if (thread.type === "overflow") {
    return abortTransaction(
      new HandlerError({
        status: 409,
        message: "Reader answer thread has reached its message limit",
      }),
    );
  }
  return thread.rows;
};

/** Validation and corpus I/O finish before the locked turn transaction. */
export const prepareReaderAnswer = async (
  options: PrepareReaderAnswerOptions,
) => {
  const { command, readDecision: _readDecision, ...scope } = options;
  const context = await readReaderAnswerContext(options);
  if (Result.isError(context)) {
    return Result.err(context.error);
  }
  const { decision, anchor, answerId } = context.value;
  const decisionId = decision.decisionId;
  const claimed = await abortableTx(scope.safeDb, async (tx) => {
    let answer;
    if (command.type === "create") {
      answer = (
        await tx
          .insert(legalReaderAnswers)
          .values({
            id: answerId,
            organizationId: scope.organizationId,
            userId: scope.userId,
            decisionId,
            kind: command.body.kind,
            visibility: "private",
            ...anchor,
          })
          .returning()
      ).at(0);
    } else {
      await withAggregateLock({
        tx,
        aggregate: "readerAnswer",
        id: {
          id: answerId,
          organizationId: scope.organizationId,
          userId: scope.userId,
        },
        mode: "update",
      });
      answer = (
        await tx
          .select()
          .from(legalReaderAnswers)
          .where(answerOwnerPredicate({ ...scope, answerId }))
          .limit(1)
      ).at(0);
    }
    if (answer === undefined) {
      return abortTransaction(
        new HandlerError({
          status: 404,
          message: "Reader answer not found",
        }),
      );
    }
    const messages = await readReaderAnswerThread(tx, answerId);
    const streaming = messages.find(({ status }) => status === "streaming");
    const now = new Date();
    if (
      streaming !== undefined &&
      now.getTime() < readerAnswerDeadlineAt(streaming.updatedAt)
    ) {
      return abortTransaction(
        new HandlerError({
          status: 409,
          message: "A reader answer is already streaming",
        }),
      );
    }
    if (streaming !== undefined) {
      await transitionScopedCount({
        tx,
        spec: TRANSITIONS.legalReaderAnswerMessages,
        where:
          and(
            eq(legalReaderAnswerMessages.answerId, answerId),
            eq(legalReaderAnswerMessages.status, "streaming"),
          ) ?? panic("Reader answer transition requires its owner predicate"),
        options: {
          from: ["streaming"],
          to: "failed",
          set: { errorCode: "owner-lost", updatedAt: now },
        },
        recordTransitionAuditEvent: async (auditTx) =>
          await scope.recordAuditEvent(auditTx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER,
            resourceId: answerId,
          }),
      });
    }
    if (command.type === "regenerate") {
      return await regenerateLastReaderAnswer({
        tx,
        scope,
        answer,
        messages,
        now,
      });
    }
    if (messages.length + 2 > READER_ANSWER_MAX_MESSAGES) {
      return abortTransaction(
        new HandlerError({
          status: 409,
          message: "Reader answer thread has reached its message limit",
        }),
      );
    }
    let question;
    if (command.type === "follow-up") {
      question = command.body.question;
    } else if (command.body.kind === "ask") {
      question = command.body.question;
    } else {
      question = "Explain the selected passage.";
    }
    if (question.trim().length === 0) {
      return abortTransaction(
        new HandlerError({
          status: 400,
          message: "A question must contain text",
        }),
      );
    }
    const messageId = createSafeId<"legalReaderAnswerMessage">();
    // The parent lock serializes sequence allocation across turn claims.
    let nextSequence = 1;
    for (const { sequence } of messages) {
      nextSequence = Math.max(nextSequence, sequence + 1);
    }
    const inserted = await tx
      .insert(legalReaderAnswerMessages)
      .values([
        {
          id: createSafeId<"legalReaderAnswerMessage">(),
          answerId,
          sequence: nextSequence,
          role: "user",
          content: question,
          status: "complete",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: messageId,
          answerId,
          sequence: nextSequence + 1,
          role: "assistant",
          content: "",
          status: "streaming",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning({
        ...getColumns(legalReaderAnswerMessages),
        claimToken: timestampCasToken(legalReaderAnswerMessages.updatedAt),
      });
    const assistant =
      inserted.find(({ id }) => id === messageId) ??
      panic("Reader answer did not create its claimed message");
    await tx
      .update(legalReaderAnswers)
      .set({ updatedAt: now })
      .where(answerOwnerPredicate({ ...scope, answerId }));
    await scope.recordAuditEvent(tx, {
      action:
        command.type === "create" ? AUDIT_ACTION.CREATE : AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER,
      resourceId: answerId,
    });
    return {
      answer,
      messageId,
      deadlineAt: readerAnswerDeadlineAt(assistant.updatedAt),
      claimToken: assistant.claimToken,
      history: [...messages, ...inserted.filter(({ role }) => role === "user")],
    };
  });
  if (Result.isError(claimed)) {
    return Result.err(claimed.error);
  }
  return Result.ok({
    ...claimed.value,
    decision,
    anchor,
    locale: command.body.locale,
    modelId: command.body.modelId,
  });
};

export type PreparedReaderAnswer = Extract<
  Awaited<ReturnType<typeof prepareReaderAnswer>>,
  { status: "ok" }
>["value"];
