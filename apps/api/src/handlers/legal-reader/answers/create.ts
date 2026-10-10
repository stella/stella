import { Result } from "better-result";

import { prepareReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import type { PrepareReaderAnswerOptions } from "@/api/handlers/legal-reader/answers/operation";
import { createAnswerBodySchema } from "@/api/handlers/legal-reader/answers/schema";
import { streamReaderAnswer } from "@/api/handlers/legal-reader/answers/stream";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { createModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

const config = {
  permissions: { legalReaderAnnotation: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    "Explain or ask about a decision passage in a private reader answer thread.",
  mcp: { type: "internal", reason: "realtime_stream" },
  requiresUsage: { actionType: "chat", laneRouting: true },
  body: createAnswerBodySchema,
} satisfies HandlerConfig;

export const createReaderAnswerHandler = async function* (
  options: Omit<PrepareReaderAnswerOptions, "command"> & {
    body: Extract<
      PrepareReaderAnswerOptions["command"],
      { type: "create" }
    >["body"];
  },
) {
  const { body, ...scope } = options;
  return yield* Result.await(
    prepareReaderAnswer({ ...scope, command: { type: "create", body } }),
  );
};

const createReaderAnswer = createSafeRootHandler(config, async function* (ctx) {
  const {
    body,
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
  } = ctx;
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
    prepareReaderAnswer({ ...scope, command: { type: "create", body } }),
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
});
declareAggregateMutation(createReaderAnswer.handler, {
  type: "aggregate",
  aggregates: ["readerAnswer"],
});
export default createReaderAnswer;
