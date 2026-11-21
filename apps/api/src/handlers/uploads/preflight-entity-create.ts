import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { validateEntityCreateCapacity } from "@/api/lib/uploads/entity-create";
import { findExactDuplicates } from "@/api/lib/uploads/exact-duplicates";
import { documentUploadFileFields } from "@/api/lib/uploads/file-metadata-schema";

const bodySchema = v.object({
  entityCount: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(LIMITS.entitiesCount),
  ),
  propertyId: v.optional(v.nullable(resourceIdSchema("property"))),
  parentId: v.optional(v.nullable(resourceIdSchema("entity"))),
  /** Hashes of the files about to be uploaded, to learn which the matter already holds. */
  sha256Hexes: v.optional(
    v.pipe(
      v.array(documentUploadFileFields.sha256Hex),
      v.maxLength(LIMITS.entitiesCount),
    ),
    [],
  ),
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

    const duplicates = yield* Result.await(
      safeDb(
        async (tx) =>
          await findExactDuplicates({
            tx,
            workspaceId,
            sha256Hexes: body.sha256Hexes,
          }),
      ),
    );

    return Result.ok({ ok: true, duplicates });
  },
);

export default preflightEntityCreate;
