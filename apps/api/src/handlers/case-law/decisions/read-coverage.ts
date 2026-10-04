import { Result } from "better-result";
import { t } from "elysia";

import { readCaseLawCoverageHandler } from "@/api/handlers/case-law/decisions/coverage";
import { coverageResponseSchema } from "@/api/handlers/case-law/public-response-schemas";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { projectResponseText } from "@/api/lib/search/project-response-text";
import { boundedString } from "@/api/lib/search/response-text-bounds";
import { preventPublicCaching } from "@/api/lib/security-headers";

// The coverage page reads "cannot state the figures" as an answer, not a failure.
const coverageAnswerSchema = t.Union([
  coverageResponseSchema,
  t.Object({ message: boundedString(2048) }, { additionalProperties: false }),
]);

const config = {
  cache: { kind: "public", maxAge: 900, swr: 3600 },
  response:
    safePublicHandlerResponseSchemasWithStatusText(coverageAnswerSchema),
  // Not a capability: it takes no input, opts into shared response caching,
  // and is gated by the public-law route hook, none of which the generic
  // invoke path can honor.
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "public_indexing" },
} satisfies PublicHandlerConfig;

/** The corpus's own coverage, every country in one answer. */
const readCaseLawCoverage = createSafeBoundedPublicHandler(
  config,
  async function* ({ set }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await readCaseLawCoverageHandler(caseLawPublicReadDb),
      ),
    );
    if ("message" in response) {
      preventPublicCaching(set);
    }

    return Result.ok(projectResponseText(response, coverageAnswerSchema));
  },
);

export default readCaseLawCoverage;
