import { Result } from "better-result";

import { prepareReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import { readerAnswerRequest } from "@/api/handlers/legal-reader/answers/request";
import {
  answerParamsSchema,
  followUpBodySchema,
} from "@/api/handlers/legal-reader/answers/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

const config = {
  contract: "patch",
  permissions: { legalReaderAnnotation: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description: "Ask a follow-up in your reader answer thread.",
  mcp: { type: "internal", reason: "realtime_stream" },
  requiresUsage: { actionType: "chat", laneRouting: true },
  params: answerParamsSchema,
  body: followUpBodySchema,
} satisfies HandlerConfig;

const followUpReaderAnswer = createSafeRootHandler(
  config,
  async function* (ctx) {
    const request = yield* readerAnswerRequest(ctx);
    const prepared = yield* Result.await(
      prepareReaderAnswer({
        ...request.scope,
        command: {
          type: "follow-up",
          body: ctx.body,
          answerId: ctx.params.answerId,
        },
      }),
    );
    return Result.ok(request.stream(prepared));
  },
);
declareAggregateMutation(followUpReaderAnswer, {
  type: "aggregate",
  aggregates: ["readerAnswer"],
});
export default followUpReaderAnswer;
