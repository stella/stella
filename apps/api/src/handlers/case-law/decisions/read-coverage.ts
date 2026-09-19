import { Result } from "better-result";

import {
  COVERAGE_CACHE_CONTROL,
  readCaseLawCoverageHandler,
} from "@/api/handlers/case-law/decisions/coverage";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";

const config = {
  // Not a capability: it takes no input, sets its own cache-control header,
  // and is gated by the public-law route hook, none of which the generic
  // invoke path can honor.
  mcp: { type: "internal", reason: "public_indexing" },
} satisfies PublicHandlerConfig;

/** The corpus's own coverage, every country in one answer. */
const readCaseLawCoverage = createSafePublicHandler(
  config,
  async function* ({ set }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await readCaseLawCoverageHandler(caseLawPublicReadDb),
      ),
    );
    set.headers["cache-control"] = COVERAGE_CACHE_CONTROL;

    return Result.ok(response);
  },
);

export default readCaseLawCoverage;
