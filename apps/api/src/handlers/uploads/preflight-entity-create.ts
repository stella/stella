import { Result } from "better-result";
import { t } from "elysia";

import { validateEntityCreateCapacity } from "@/api/handlers/uploads/entity-create";
import {
  authorizeUploadPurpose,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const bodySchema = t.Object({
  entityCount: t.Integer({ minimum: 1, maximum: LIMITS.entitiesCount }),
  propertyId: t.Optional(t.Nullable(tSafeId("property"))),
  parentId: t.Optional(t.Nullable(tSafeId("entity"))),
});

const config = {
  permissions: uploadRoutePermission,
  body: bodySchema,
} satisfies HandlerConfig;

const preflightEntityCreate = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, memberRole, body }) {
    const authorization = authorizeUploadPurpose({
      memberRole,
      purpose: "entity_create",
    });
    if (Result.isError(authorization)) {
      return Result.err(authorization.error);
    }

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
