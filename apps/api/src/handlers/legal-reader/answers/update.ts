import { Result } from "better-result";

import type { ReaderAnnotationVisibility } from "@stll/api-contract/legal-reader-annotations";

import { abortableTx } from "@/api/db/safe-db";
import { legalReaderAnswers } from "@/api/db/schema";
import { answerOwnerPredicate } from "@/api/handlers/legal-reader/answers/operation";
import {
  answerParamsSchema,
  answerVisibilityBodySchema,
} from "@/api/handlers/legal-reader/answers/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { AnnotationAuthorScope } from "@/api/lib/legal-search/reader-annotations/target";

const config = {
  contract: "patch",
  permissions: { legalReaderAnnotation: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    "Share your reader answer with colleagues or make it private again.",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: answerParamsSchema,
  body: answerVisibilityBodySchema,
} satisfies HandlerConfig;
const updateReaderAnswerHandler = async (
  scope: AnnotationAuthorScope & {
    answerId: SafeId<"legalReaderAnswer">;
    body: { visibility: ReaderAnnotationVisibility };
  },
) => {
  const result = await abortableTx(scope.safeDb, async (tx) => {
    await withAggregateLock({
      tx,
      aggregate: "readerAnswer",
      id: {
        id: scope.answerId,
        organizationId: scope.organizationId,
        userId: scope.userId,
      },
      mode: "update",
    });
    const updated = await tx
      .update(legalReaderAnswers)
      .set({ visibility: scope.body.visibility, updatedAt: new Date() })
      .where(answerOwnerPredicate(scope))
      .returning({ id: legalReaderAnswers.id });
    if (updated.length > 0) {
      await scope.recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER,
        resourceId: scope.answerId,
      });
    }
    return updated;
  });
  return result.andThen((rows) => {
    if (rows.length === 0) {
      return Result.err(
        new HandlerError({ status: 404, message: "Reader answer not found" }),
      );
    }
    return Result.ok({ id: scope.answerId, visibility: scope.body.visibility });
  });
};
const updateReaderAnswer = createSafeRootHandler(
  config,
  async function* ({ body, params, recordAuditEvent, safeDb, session, user }) {
    return Result.ok(
      yield* Result.await(
        updateReaderAnswerHandler({
          body,
          answerId: params.answerId,
          recordAuditEvent,
          safeDb,
          organizationId: session.activeOrganizationId,
          userId: user.id,
        }),
      ),
    );
  },
);
declareAggregateMutation(updateReaderAnswer.handler, {
  type: "aggregate",
  aggregates: ["readerAnswer"],
});
export default updateReaderAnswer;
