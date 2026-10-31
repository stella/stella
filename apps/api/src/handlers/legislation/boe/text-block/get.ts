import { Result } from "better-result";
import * as v from "valibot";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { boeClient } from "@/api/lib/legal-search/boe-client";

const paramsSchema = v.object({
  lawId: v.pipe(v.string(), v.regex(/^BOE-[A-Z]-\d{4}-\d+$/u)),
  blockId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});

const boeTextBlock = createSafeRootHandler(
  {
    contract: "patch",
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
