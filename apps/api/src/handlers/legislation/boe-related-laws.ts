import { Result } from "better-result";
import { t } from "elysia";

import { findRelatedLaws, RELATION_TYPES } from "@stll/boe";
import type { RelationType } from "@stll/boe";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const paramsSchema = t.Object({
  lawId: t.String({ pattern: "^BOE-[A-Z]-\\d{4}-\\d+$" }),
});

const querySchema = t.Object({
  relationType: t.Optional(
    t.Union([
      t.Literal(RELATION_TYPES.all),
      t.Literal(RELATION_TYPES.modifies),
      t.Literal(RELATION_TYPES.modifiedBy),
      t.Literal(RELATION_TYPES.derogates),
      t.Literal(RELATION_TYPES.derogatedBy),
    ]),
  ),
});

const boeRelatedLaws = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "covered", by: "search_legislation" },
    access: "read",
    params: paramsSchema,
    query: querySchema,
  },
  async function* ({ params: { lawId }, query }) {
    const relationType: RelationType = query.relationType ?? RELATION_TYPES.all;

    const result = yield* Result.await(
      Result.tryPromise({
        try: async () => await findRelatedLaws(lawId, relationType),
        catch: mapBoeError,
      }),
    );

    return Result.ok(result);
  },
);

export default boeRelatedLaws;
