import { Result } from "better-result";
import * as v from "valibot";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { boeClient } from "@/api/lib/legal-search/boe-client";

const paramsSchema = v.object({
  date: v.pipe(v.string(), v.regex(/^\d{8}$/u)),
});

const bormeSummary = createSafeRootHandler(
  {
    contract: "patch",
    description:
      "Read the BORME summary the Spanish commercial registry gazette " +
      "published on one date, given as YYYYMMDD.",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: {
      type: "capability",
      readClass: "public",
      reason: "legal_corpus_admin",
      consumesServices: false,
    },
    access: "read",
    params: paramsSchema,
  },
  async function* ({ params: { date } }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await boeClient(grantThirdPartyOutboundPermit()).getBormeSummary(
            date,
          ),
        catch: mapBoeError,
      }),
    );

    return Result.ok({ date, summary: result });
  },
);

export default bormeSummary;
