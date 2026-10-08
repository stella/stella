import { Result } from "better-result";
import { t } from "elysia";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { boeClient } from "@/api/lib/legal-search/boe-client";

const paramsSchema = t.Object({
  lawId: t.String({ pattern: "^BOE-[A-Z]-\\d{4}-\\d+$" }),
});

const querySchema = t.Object({
  metadata: t.Optional(t.BooleanString()),
  analysis: t.Optional(t.BooleanString()),
  fullText: t.Optional(t.BooleanString()),
  eli: t.Optional(t.BooleanString()),
});

const boeGetLaw = createSafeRootHandler(
  {
    description:
      "Read one consolidated Spanish law from the BOE by its BOE-X-YYYY-N " +
      "identifier. The metadata, analysis, fullText, and eli flags select " +
      "which blocks the BOE returns; this queries the BOE service directly " +
      "rather than the stella legislation corpus.",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "search_boe_legislation" },
    access: "read",
    params: paramsSchema,
    query: querySchema,
  },
  async function* ({ params: { lawId }, query }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await boeClient(grantThirdPartyOutboundPermit()).getConsolidatedLaw(
            lawId,
            query,
          ),
        catch: mapBoeError,
      }),
    );

    return Result.ok(result);
  },
);

export default boeGetLaw;
