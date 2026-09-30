import { Result } from "better-result";

import { readCaseLawCoverageHandler } from "@/api/handlers/case-law/decisions/coverage";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { preventPublicCaching } from "@/api/lib/cache-policy";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";

const config = {
  cache: { kind: "public", maxAge: 900, swr: 3600 },
  // Not a capability: it takes no input, opts into shared response caching,
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
    if ("message" in response) {
      preventPublicCaching(set);
    }

    return Result.ok(response);
  },
);

export default readCaseLawCoverage;
