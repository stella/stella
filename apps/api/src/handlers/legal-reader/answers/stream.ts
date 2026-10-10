import { Result } from "better-result";
import { and, eq, exists } from "drizzle-orm";

import type {
  ReaderAnswerCitation,
  ReaderAnswerStreamEvent,
  ReaderAnswerUsage,
} from "@stll/api-contract/reader-answers";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { legalReaderAnswerMessages, legalReaderAnswers } from "@/api/db/schema";
import type { AnnotationAuthorScope } from "@/api/handlers/legal-reader/annotations/target";
import { runReaderAnswerModel } from "@/api/handlers/legal-reader/answers/model";
import type { ReaderAnswerModelRunner } from "@/api/handlers/legal-reader/answers/model";
import { answerOwnerPredicate } from "@/api/handlers/legal-reader/answers/operation";
import type { PreparedReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import {
  buildReaderAnswerPrompt,
  validateReaderAnswerCitations,
} from "@/api/handlers/legal-reader/answers/prompt";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { ModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
  SSE_MEDIA_TYPE,
} from "@/api/lib/security-headers";
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
  settlement:
    | { status: "failed"; content: string; citations: ReaderAnswerCitation[] }
    | {
        status: "complete";
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
}: PersistReaderAnswerSettlementOptions) =>
  await scope.safeDb(async (tx) => {
    const rows = await tx
      .update(legalReaderAnswerMessages)
      .set({ ...settlement, updatedAt: new Date() })
      .where(streamOwnerPredicate({ tx, scope, prepared }))
      .returning({ id: legalReaderAnswerMessages.id });
    if (rows.length > 0) {
      await scope.recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER,
        resourceId: prepared.answer.id,
      });
    }
    return rows.length > 0;
  });

type FailReaderAnswerStreamOptions = {
  scope: AnnotationAuthorScope;
  prepared: PreparedReaderAnswer;
  error: unknown;
  content: string;
  allowed: ReaderAnswerCitation[];
};
const failReaderAnswerStream = async ({
  scope,
  prepared,
  error,
  content,
  allowed,
}: FailReaderAnswerStreamOptions) => {
  observeFailure(error, { sink: READER_ANSWER_GENERATION_FAILURE });
  const partial = validateReaderAnswerCitations({ content, allowed });
  const failed = await persistReaderAnswerSettlement({
    scope,
    prepared,
    settlement: {
      status: "failed",
      content: partial.content,
      citations: partial.citations,
    },
  });
  if (failed.isErr()) {
    observeFailure(failed.error, { sink: READER_ANSWER_PERSISTENCE_FAILURE });
  }
  return {
    type: "failed",
    messageId: prepared.messageId,
    message: "Reader answer generation failed",
    ...partial,
  } as const satisfies ReaderAnswerStreamEvent;
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
                              paragraphId: prepared.anchor.paragraphId,
                              system: prompt.system,
                              messages: [
                                { role: "user", content: prompt.context },
                                ...prepared.history
                                  .filter(({ status }) => status === "complete")
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
                          const saved = yield* Result.await(
                            persistReaderAnswerSettlement({
                              scope,
                              prepared,
                              settlement: {
                                status: "complete",
                                content: validated.content,
                                citations: validated.citations,
                                model: output.model,
                                usage: output.usage,
                              },
                            }),
                          );
                          if (!saved) {
                            return Result.err(
                              new HandlerError({
                                status: 409,
                                message:
                                  "Reader answer turn no longer belongs to this stream",
                              }),
                            );
                          }
                          emit({
                            type: "complete",
                            messageId: prepared.messageId,
                            ...validated,
                            model: output.model,
                            usage: output.usage,
                          });
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
        emit(
          await failReaderAnswerStream({
            scope,
            prepared,
            error: outcome.error,
            content: partialContent,
            allowed,
          }),
        );
      }
      if (connected) {
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
