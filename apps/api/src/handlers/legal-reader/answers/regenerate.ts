import { Result } from "better-result";

import { prepareReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import { readerAnswerRequest } from "@/api/handlers/legal-reader/answers/request";
import {
  answerParamsSchema,
  regenerateBodySchema,
} from "@/api/handlers/legal-reader/answers/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  contract: "patch",
  permissions: { legalReaderAnnotation: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    "Regenerate the last assistant message in your reader answer thread.",
  mcp: { type: "internal", reason: "realtime_stream" },
  requiresUsage: { actionType: "chat", laneRouting: true },
  params: answerParamsSchema,
  body: regenerateBodySchema,
  aggregateMutation: {
    type: "aggregate",
    aggregates: ["readerAnswer"],
  },
} satisfies HandlerConfig;

const regenerateReaderAnswer = createSafeRootHandler(
  config,
  async function* (ctx) {
    const request = yield* readerAnswerRequest(ctx);
    const prepared = yield* Result.await(
      prepareReaderAnswer({
        ...request.scope,
        command: {
          type: "regenerate",
          body: ctx.body,
          answerId: ctx.params.answerId,
        },
      }),
    );
    return Result.ok(request.stream(prepared));
  },
);
export default regenerateReaderAnswer;
