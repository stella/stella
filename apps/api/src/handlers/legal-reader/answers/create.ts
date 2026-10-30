import { Result } from "better-result";

import { prepareReaderAnswer } from "@/api/handlers/legal-reader/answers/operation";
import { readerAnswerRequest } from "@/api/handlers/legal-reader/answers/request";
import { createAnswerBodySchema } from "@/api/handlers/legal-reader/answers/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

const config = {
  contract: "patch",
  permissions: { legalReaderAnnotation: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    "Explain or ask about a decision passage in a private reader answer thread.",
  mcp: { type: "internal", reason: "realtime_stream" },
  requiresUsage: { actionType: "chat", laneRouting: true },
  body: createAnswerBodySchema,
} satisfies HandlerConfig;

const createReaderAnswer = createSafeRootHandler(config, async function* (ctx) {
  const request = yield* readerAnswerRequest(ctx);
  const prepared = yield* Result.await(
    prepareReaderAnswer({
      ...request.scope,
      command: { type: "create", body: ctx.body },
    }),
  );
  return Result.ok(request.stream(prepared));
});
declareAggregateMutation(createReaderAnswer, {
  type: "aggregate",
  aggregates: ["readerAnswer"],
});
export default createReaderAnswer;
