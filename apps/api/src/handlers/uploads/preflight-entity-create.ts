import { Result } from "better-result";
import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { validateEntityCreateCapacity } from "@/api/lib/uploads/entity-create";

const bodySchema = t.Object({
  entityCount: t.Integer({ minimum: 1, maximum: LIMITS.entitiesCount }),
  propertyId: t.Optional(t.Nullable(tSafeId("property"))),
  parentId: t.Optional(t.Nullable(tSafeId("entity"))),
});

// Answers whether the upload that follows would fit, so it asks for the grant
// that upload spends rather than the baseline every role holds.
const config = {
  permissions: { entity: ["create"] },
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
