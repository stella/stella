import { Result } from "better-result";
import * as v from "valibot";

import { RELATION_TYPES } from "@stll/boe";
import type { RelationType } from "@stll/boe";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { boeClient } from "@/api/lib/legal-search/boe-client";

const paramsSchema = v.object({
  lawId: v.pipe(v.string(), v.regex(/^BOE-[A-Z]-\d{4}-\d+$/u)),
});

const querySchema = v.object({
  relationType: v.optional(
    v.union([
      v.literal(RELATION_TYPES.all),
      v.literal(RELATION_TYPES.modifies),
      v.literal(RELATION_TYPES.modifiedBy),
      v.literal(RELATION_TYPES.derogates),
      v.literal(RELATION_TYPES.derogatedBy),
    ]),
  ),
});

const boeRelatedLaws = createSafeRootHandler(
  {
    contract: "patch",
    description:
      "List the Spanish BOE laws related to one law, narrowed by " +
      "relationType: modifies, modifiedBy, derogates, derogatedBy, or all " +
      "(the default).",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "search_boe_legislation" },
    access: "read",
    params: paramsSchema,
    query: querySchema,
  },
  async function* ({ params: { lawId }, query }) {
    const relationType: RelationType = query.relationType ?? RELATION_TYPES.all;

    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await boeClient(grantThirdPartyOutboundPermit()).findRelatedLaws(
            lawId,
            relationType,
          ),
        catch: mapBoeError,
      }),
    );

    return Result.ok(result);
  },
);

export default boeRelatedLaws;
