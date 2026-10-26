import { panic, Result } from "better-result";
import { and, eq, exists, sql } from "drizzle-orm";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";
import type {
  ReaderAnswerCitation,
  ReaderAnswerErrorCode,
  ReaderAnswerStreamEvent,
  ReaderAnswerUsage,
} from "@stll/api-contract/reader-answers";
import {
  READER_ANSWER_DEADLINE_MS,
  READER_ANSWER_ERROR_CODES,
} from "@stll/api-contract/reader-answers";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { legalReaderAnswerMessages, legalReaderAnswers } from "@/api/db/schema";
import { runReaderAnswerModel } from "@/api/handlers/legal-reader/answers/model";
import type { ReaderAnswerModelRunner } from "@/api/handlers/legal-reader/answers/model";
import { answerOwnerPredicate } from "@/api/handlers/legal-reader/answers/operation";
import type { PreparedReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import {
  buildReaderAnswerPrompt,
  validateReaderAnswerCitations,
} from "@/api/handlers/legal-reader/answers/prompt";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
  SSE_MEDIA_TYPE,
} from "@/api/http/cache";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { timestampMatchesCasToken } from "@/api/lib/db/timestamp-cas";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionScopedCount } from "@/api/lib/db/transitions";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { AnnotationAuthorScope } from "@/api/lib/legal-search/reader-annotations/target";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { ModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import type { UsageLaneDecision } from "@/api/lib/usage/lane-routing";
import { withTimeout } from "@/api/lib/with-timeout";

const READER_ANSWER_GENERATION_FAILURE = failureSink({
  event: "reader_answer.generation_failed",
  expected: [],
});
const READER_ANSWER_PERSISTENCE_FAILURE = failureSink({
  event: "reader_answer.persistence_failed",
  expected: [],
});

const readerAnswerFailureCode = (
  error: unknown,
  fallbackCode: ReaderAnswerErrorCode,
): ReaderAnswerErrorCode => {
  if (ActionAdmissionError.is(error)) {
    return error.code;
  }
  if (HandlerError.is(error)) {
    return (
      READER_ANSWER_ERROR_CODES.find((code) => code === error.code) ??
      fallbackCode
    );
  }
  return fallbackCode;
};

type StreamOwnerPredicateOptions = {
  tx: Transaction;
  scope: AnnotationAuthorScope;
  prepared: PreparedReaderAnswer;
};
const streamOwnerPredicate = ({
  tx,
  scope,
  prepared,
}: StreamOwnerPredicateOptions) =>
  and(
    eq(legalReaderAnswerMessages.id, prepared.messageId),
    eq(legalReaderAnswerMessages.answerId, prepared.answer.id),
    eq(legalReaderAnswerMessages.status, "streaming"),
    timestampMatchesCasToken(
      legalReaderAnswerMessages.updatedAt,
      prepared.claimToken,
    ),
    exists(
      tx
        .select({ id: legalReaderAnswers.id })
        .from(legalReaderAnswers)
        .where(
          answerOwnerPredicate({ ...scope, answerId: prepared.answer.id }),
        ),
    ),
  );

type PersistReaderAnswerSettlementOptions = {
  scope: AnnotationAuthorScope;
  prepared: PreparedReaderAnswer;
  invalidCitationCount: number;
  settlement:
    | {
        status: "failed";
        errorCode: ReaderAnswerErrorCode;
        content: string;
        citations: ReaderAnswerCitation[];
      }
    | {
        status: "complete";
        errorCode: null;
        content: string;
        citations: ReaderAnswerCitation[];
        model: string;
        usage: ReaderAnswerUsage | null;
      };
};

/** Settlement and audit share the transaction and the current message claim. */
const persistReaderAnswerSettlement = async ({
  scope,
  prepared,
  settlement,
  invalidCitationCount,
}: PersistReaderAnswerSettlementOptions) =>
  await scope.safeDb(async (tx) => {
    const ownerPredicate =
      streamOwnerPredicate({ tx, scope, prepared }) ??
      panic("Reader answer settlement requires its owner predicate");
    // An UPDATE can evaluate its predicate before waiting on an unchanged row.
    // Acquire the claim lock first so the execution clock is checked after the wait.
    const locked = await withAggregateLock({
      tx,
      aggregate: "readerAnswerMessage",
      id: { id: prepared.messageId, answerId: prepared.answer.id },
      mode: "update",
    });
    switch (locked.status) {
      case "missing":
        return null;
      case "locked":
        break;
      case "busy":
        return panic("A blocking reader message lock cannot be busy");
      default:
        locked satisfies never;
        return panic("Unknown reader message lock outcome");
    }
    const claimDeadline = sql`${legalReaderAnswerMessages.updatedAt} + ${READER_ANSWER_DEADLINE_MS}::double precision * interval '1 millisecond'`;
    const deadlinePredicate =
      settlement.status === "failed" && settlement.errorCode === "timeout"
        ? sql`${claimDeadline} <= clock_timestamp()`
        : sql`${claimDeadline} > clock_timestamp()`;
    const { status, ...metadata } = settlement;
    const count = await transitionScopedCount({
      tx,
      spec: TRANSITIONS.legalReaderAnswerMessages,
      where:
        and(ownerPredicate, deadlinePredicate) ??
        panic("Reader settlement requires its deadline fence"),
      options: {
        from: ["streaming"],
        to: status,
        set: { ...metadata, invalidCitationCount, updatedAt: new Date() },
      },
      recordTransitionAuditEvent: async (auditTx) =>
        await scope.recordAuditEvent(auditTx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER,
          resourceId: prepared.answer.id,
        }),
    });
    if (count === 0) {
      return null;
    }
    const saved =
      (
        await tx
          .select({
            id: legalReaderAnswerMessages.id,
            status: legalReaderAnswerMessages.status,
            content: legalReaderAnswerMessages.content,
            citations: legalReaderAnswerMessages.citations,
            model: legalReaderAnswerMessages.model,
            usage: legalReaderAnswerMessages.usage,
            errorCode: legalReaderAnswerMessages.errorCode,
            invalidCitationCount:
              legalReaderAnswerMessages.invalidCitationCount,
          })
          .from(legalReaderAnswerMessages)
          .where(eq(legalReaderAnswerMessages.id, prepared.messageId))
          .limit(1)
      ).at(0) ?? panic("A transitioned reader message must exist");
    const evidence = {
      messageId: saved.id,
      content: saved.content,
      citations: saved.citations,
      invalidCitationCount: saved.invalidCitationCount,
    };
    switch (saved.status) {
      case "complete":
        return {
          type: "complete",
          ...evidence,
          model: saved.model ?? panic("Completed reader answer has no model"),
          usage: saved.usage,
        } as const satisfies ReaderAnswerStreamEvent;
      case "failed":
        return {
          type: "failed",
          ...evidence,
          message: "Reader answer generation failed",
          errorCode:
            saved.errorCode ?? panic("Failed reader answer has no error code"),
        } as const satisfies ReaderAnswerStreamEvent;
      case "streaming":
        return panic("Reader answer settlement did not reach a terminal state");
      default:
        saved.status satisfies never;
        return panic("Reader answer settlement status is unhandled");
    }
  });

type FailReaderAnswerStreamOptions = {
  scope: AnnotationAuthorScope;
  prepared: PreparedReaderAnswer;
  error: unknown;
  fallbackCode: ReaderAnswerErrorCode;
  content: string;
  allowed: ReaderAnswerCitation[];
  emit: (event: ReaderAnswerStreamEvent) => void;
};
const failReaderAnswerStream = async ({
  scope,
  prepared,
  error,
  fallbackCode,
  content,
  allowed,
  emit,
}: FailReaderAnswerStreamOptions) => {
  observeFailure(error, { sink: READER_ANSWER_GENERATION_FAILURE });
  const partial = validateReaderAnswerCitations({ content, allowed });
  const failureCode = readerAnswerFailureCode(error, fallbackCode);
  let failed = await persistReaderAnswerSettlement({
    scope,
    prepared,
    invalidCitationCount: partial.invalidCitationCount,
    settlement: {
      status: "failed",
      errorCode: failureCode,
      content: partial.content,
      citations: partial.citations,
    },
  });
  if (failed.isOk() && failed.value === null && failureCode !== "timeout") {
    // An ordinary failure can wait past expiry too; only the expired claim may
    // persist the timeout, and a newer owner or a terminal row still matches nothing.
    failed = await persistReaderAnswerSettlement({
      scope,
      prepared,
      invalidCitationCount: partial.invalidCitationCount,
      settlement: {
        status: "failed",
        errorCode: "timeout",
        content: partial.content,
        citations: partial.citations,
      },
    });
  }
  if (failed.isErr()) {
    observeFailure(failed.error, { sink: READER_ANSWER_PERSISTENCE_FAILURE });
    // Storage is unavailable; the claim remains reclaimable at its deadline.
    emit({
      type: "failed",
      messageId: prepared.messageId,
      message: "Reader answer generation failed",
      errorCode: "persistence",
      content: partial.content,
      citations: partial.citations,
      invalidCitationCount: partial.invalidCitationCount,
    });
  }
  return failed;
};

export type ReaderAnswerStreamOptions = AnnotationAuthorScope & {
  prepared: PreparedReaderAnswer;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  admitModelAction: ModelActionAdmitter;
  requestSignal: AbortSignal;
  runModel?: ReaderAnswerModelRunner;
  usageLane?: UsageLaneDecision;
};

/** Admission remains held until the stream settles, including every tool round. */
export const streamReaderAnswer = ({
  prepared,
  orgAIConfig,
  managedAIResidency,
  admitModelAction,
  requestSignal,
  runModel = runReaderAnswerModel,
  usageLane = { lane: "pool" },
  ...scope
}: ReaderAnswerStreamOptions): Response => {
  const cancellation = new AbortController();
  const prompt = buildReaderAnswerPrompt(prepared);
  const allowed: ReaderAnswerCitation[] = [...prompt.citations];
  const encoder = new TextEncoder();
  let partialContent = "";
  let connected = true;
  let failureCode: ReaderAnswerErrorCode =
    ACTION_ADMISSION_CODES.admissionUnavailable;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ReaderAnswerStreamEvent) => {
        if (connected) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
      };
      emit({
        type: "started",
        answerId: prepared.answer.id,
        messageId: prepared.messageId,
      });
      const interrupted = (cause?: unknown) =>
        new HandlerError({
          status: 502,
          message: "Reader answer generation was interrupted",
          cause,
        });
      const remainingMs =
        prepared.deadlineAt - Temporal.Now.instant().epochMilliseconds;
      const admitted =
        remainingMs <= 0
          ? Result.err(interrupted())
          : await Result.tryPromise({
              try: async () =>
                await withTimeout(
                  async (deadlineSignal) =>
                    await admitModelAction(
                      async ({ admission, signal }) =>
                        await Result.gen(async function* () {
                          failureCode = "provider-error";
                          const runSignal = AbortSignal.any([
                            signal,
                            requestSignal,
                            cancellation.signal,
                            deadlineSignal,
                          ]);
                          const expired = () =>
                            runSignal.aborted ||
                            Temporal.Now.instant().epochMilliseconds >=
                              prepared.deadlineAt;
                          if (expired()) {
                            return Result.err(interrupted());
                          }
                          const output = yield* Result.await(
                            runModel({
                              admission,
                              signal: runSignal,
                              answerId: prepared.answer.id,
                              decisionId: prepared.decision.decisionId,
                              paragraphId: prepared.anchor[0].paragraphId,
                              system: prompt.system,
                              messages: [
                                { role: "user", content: prompt.context },
                                ...prepared.history
                                  .filter(({ status }) => status === "complete")
                                  .toSorted(
                                    (left, right) =>
                                      left.sequence - right.sequence,
                                  )
                                  .map(({ role, content }) => ({
                                    role,
                                    content,
                                  })),
                              ],
                              modelId:
                                usageLane.lane === "fallback"
                                  ? usageLane.forcedModelSelection
                                  : prepared.modelId,
                              orgAIConfig,
                              managedAIResidency,
                              metering: {
                                actionType: "chat",
                                lane: usageLane.lane,
                                organizationId: scope.organizationId,
                                safeDb: scope.safeDb,
                                serviceTier: "standard",
                                userId: scope.userId,
                                workspaceId: null,
                              },
                              onDelta: (delta) => {
                                if (expired()) {
                                  return;
                                }
                                partialContent += delta;
                                emit({
                                  type: "delta",
                                  messageId: prepared.messageId,
                                  delta,
                                });
                              },
                              onEvidence: (citations) => {
                                if (expired()) {
                                  return;
                                }
                                allowed.push(...citations);
                              },
                            }),
                          );
                          if (expired()) {
                            return Result.err(interrupted());
                          }
                          const validated = validateReaderAnswerCitations({
                            content: output.content,
                            allowed,
                          });
                          failureCode = "persistence";
                          const saved = yield* Result.await(
                            persistReaderAnswerSettlement({
                              scope,
                              prepared,
                              invalidCitationCount:
                                validated.invalidCitationCount,
                              settlement: {
                                status: "complete",
                                errorCode: null,
                                content: validated.content,
                                citations: validated.citations,
                                model: output.model,
                                usage: output.usage,
                              },
                            }),
                          );
                          if (saved === null) {
                            return Result.err(interrupted());
                          }
                          emit(saved);
                          return Result.ok(undefined);
                        }),
                    ),
                  {
                    label: "reader-answer.claim",
                    signal: AbortSignal.any([
                      requestSignal,
                      cancellation.signal,
                    ]),
                    timeoutMs: remainingMs,
                  },
                ),
              catch: interrupted,
            });
      const outcome = admitted
        .andThen((admission) => admission)
        .andThen((settlement) => settlement);
      if (Result.isError(outcome)) {
        if (Temporal.Now.instant().epochMilliseconds >= prepared.deadlineAt) {
          failureCode = "timeout";
        } else if (requestSignal.aborted || cancellation.signal.aborted) {
          failureCode = "client-disconnected";
        }
        const failed = await failReaderAnswerStream({
          scope,
          prepared,
          error: outcome.error,
          fallbackCode: failureCode,
          content: partialContent,
          allowed,
          emit,
        });
        if (failed.isOk() && failed.value !== null) {
          emit(failed.value);
        }
      }
      if (connected) {
        connected = false;
        controller.close();
      }
    },
    cancel() {
      connected = false;
      cancellation.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": SSE_MEDIA_TYPE,
      [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL,
    },
  });
};
