import { Result } from "better-result";
import { t } from "elysia";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { boeClient } from "@/api/lib/legal-search/boe-client";

const paramsSchema = t.Object({
  lawId: t.String({ pattern: "^BOE-[A-Z]-\\d{4}-\\d+$" }),
  blockId: t.String({ minLength: 1, maxLength: 128 }),
});

const boeTextBlock = createSafeRootHandler(
  {
    description:
      "Read the text of one block of a consolidated Spanish BOE law, " +
      "addressed by the law identifier and a block id taken from " +
      "legislation.boe.law-structure.get.",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "search_boe_legislation" },
    access: "read",
    params: paramsSchema,
  },
  async function* ({ params: { lawId, blockId } }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await boeClient(grantThirdPartyOutboundPermit()).getLawTextBlock(
            lawId,
            blockId,
          ),
        catch: mapBoeError,
      }),
    );

    return Result.ok({ lawId, blockId, block: result });
  },
);

export default boeTextBlock;
