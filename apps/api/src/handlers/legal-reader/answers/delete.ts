import { Result } from "better-result";

import { abortableTx } from "@/api/db/safe-db";
import { legalReaderAnswers } from "@/api/db/schema";
import { answerOwnerPredicate } from "@/api/handlers/legal-reader/answers/operation";
import { answerParamsSchema } from "@/api/handlers/legal-reader/answers/schema";
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
  permissions: { legalReaderAnnotation: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description: "Permanently delete your reader answer and all its messages.",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: answerParamsSchema,
} satisfies HandlerConfig;
export const deleteReaderAnswerHandler = async (
  scope: AnnotationAuthorScope & { answerId: SafeId<"legalReaderAnswer"> },
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
    const deleted = await tx
      .delete(legalReaderAnswers)
      .where(answerOwnerPredicate(scope))
      .returning({ id: legalReaderAnswers.id });
    if (deleted.length > 0) {
      await scope.recordAuditEvent(tx, {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER,
        resourceId: scope.answerId,
      });
    }
    return deleted;
  });
  return result.andThen((rows) => {
    if (rows.length === 0) {
      return Result.err(
        new HandlerError({ status: 404, message: "Reader answer not found" }),
      );
    }
    return Result.ok({ id: scope.answerId });
  });
};
const deleteReaderAnswer = createSafeRootHandler(
  config,
  async function* ({ params, recordAuditEvent, safeDb, session, user }) {
    return Result.ok(
      yield* Result.await(
        deleteReaderAnswerHandler({
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
declareAggregateMutation(deleteReaderAnswer.handler, {
  type: "aggregate",
  aggregates: ["readerAnswer"],
});
export default deleteReaderAnswer;
