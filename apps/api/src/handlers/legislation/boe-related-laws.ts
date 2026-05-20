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
    t.UnionEnum([
      RELATION_TYPES.all,
      RELATION_TYPES.modifies,
      RELATION_TYPES.modifiedBy,
      RELATION_TYPES.derogates,
      RELATION_TYPES.derogatedBy,
    ]),
  ),
});

const boeRelatedLaws = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
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
