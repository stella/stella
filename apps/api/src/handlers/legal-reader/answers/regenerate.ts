import { Result } from "better-result";

import type { ReaderAnswerRegenerate } from "@stll/api-contract/reader-answers";

import { prepareReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import type { PrepareReaderAnswerOptions } from "@/api/handlers/legal-reader/answers/operation";
import {
  answerParamsSchema,
  regenerateBodySchema,
} from "@/api/handlers/legal-reader/answers/schema";
import { streamReaderAnswer } from "@/api/handlers/legal-reader/answers/stream";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { createModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

const config = {
  permissions: { legalReaderAnnotation: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    "Regenerate the last assistant message in your reader answer thread.",
  mcp: { type: "internal", reason: "realtime_stream" },
  requiresUsage: { actionType: "chat", laneRouting: true },
  params: answerParamsSchema,
  body: regenerateBodySchema,
} satisfies HandlerConfig;

export const regenerateReaderAnswerHandler = async function* (
  options: Omit<PrepareReaderAnswerOptions, "command"> & {
    answerId: SafeId<"legalReaderAnswer">;
    body: ReaderAnswerRegenerate;
  },
) {
  const { body, answerId, ...scope } = options;
  return yield* Result.await(
    prepareReaderAnswer({
      ...scope,
      command: { type: "regenerate", answerId, body },
    }),
  );
};

const regenerateReaderAnswer = createSafeRootHandler(
  config,
  async function* ({
    body,
    params,
    recordAuditEvent,
    safeDb,
    scopedDb,
    session,
    user,
    orgAIConfig,
    orgAIConfigStatus,
    managedAIResidency,
    request,
    usageLane,
  }) {
    const available = requireTanStackAIAvailableForRole({
      role: "chat",
      orgConfig: orgAIConfig,
      configStatus: orgAIConfigStatus,
      dataClass: "customer",
    });
    if (Result.isError(available)) {
      return available;
    }
    const scope = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
      safeDb,
      recordAuditEvent,
    };
    const prepared = yield* Result.await(
      prepareReaderAnswer({
        ...scope,
        command: { type: "regenerate", body, answerId: params.answerId },
      }),
    );
    return Result.ok(
      streamReaderAnswer({
        ...scope,
        prepared,
        orgAIConfig,
        managedAIResidency,
        requestSignal: request.signal,
        ...(usageLane === undefined ? {} : { usageLane }),
        admitModelAction: createModelActionAdmitter({
          organizationId: scope.organizationId,
          userId: scope.userId,
          organizationStateDb: scopedDb,
          actionKind: "chat.send",
          scope: "independent",
        }),
      }),
    );
  },
);
declareAggregateMutation(regenerateReaderAnswer.handler, {
  type: "aggregate",
  aggregates: ["readerAnswer"],
});
export default regenerateReaderAnswer;
