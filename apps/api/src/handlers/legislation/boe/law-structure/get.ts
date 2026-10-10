import { Result } from "better-result";
import { t } from "elysia";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { boeClient } from "@/api/lib/legal-search/boe-client";

const paramsSchema = t.Object({
  lawId: t.String({ pattern: "^BOE-[A-Z]-\\d{4}-\\d+$" }),
});

const boeLawStructure = createSafeRootHandler(
  {
    description:
      "Read the block outline of one consolidated Spanish BOE law: its " +
      "parts, articles, and provisions with the block ids that address them. " +
      "Use legislation.boe.text-block.get to fetch the text of a single block.",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "search_boe_legislation" },
    access: "read",
    params: paramsSchema,
  },
  async function* ({ params: { lawId } }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await boeClient(grantThirdPartyOutboundPermit()).getLawStructure(
            lawId,
          ),
        catch: mapBoeError,
      }),
    );

    return Result.ok({ lawId, structure: result });
  },
);

export default boeLawStructure;
