import { Result } from "better-result";
import { t } from "elysia";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { boeClient } from "@/api/lib/legal-search/boe-client";

const paramsSchema = t.Object({
  date: t.String({ pattern: "^\\d{8}$" }),
});

const bormeSummary = createSafeRootHandler(
  {
    description:
      "Read the BORME summary the Spanish commercial registry gazette " +
      "published on one date, given as YYYYMMDD.",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: {
      type: "capability",
      readClass: "public",
      reason: "legal_corpus_admin",
      consumesServices: true,
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
