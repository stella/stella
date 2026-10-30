import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { validateEntityCreateCapacity } from "@/api/lib/uploads/entity-create";

const bodySchema = v.object({
  entityCount: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(LIMITS.entitiesCount),
  ),
  propertyId: v.optional(v.nullable(resourceIdSchema("property"))),
  parentId: v.optional(v.nullable(resourceIdSchema("entity"))),
});

// Answers whether the upload that follows would fit, so it asks for the grant
// that upload spends rather than the baseline every role holds.
const config = {
  contract: "patch",
  permissions: { entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "upload_mechanics" },
  access: "read",
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

const preflightEntityCreate = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body }) {
    const validation = yield* validateEntityCreateCapacity({
      safeDb,
      workspaceId,
      propertyId: body.propertyId ?? null,
      parentId: body.parentId ?? null,
      entityCount: body.entityCount,
    });
    if (Result.isError(validation)) {
      return validation;
    }

    return Result.ok({ ok: true });
  },
);

export default preflightEntityCreate;
