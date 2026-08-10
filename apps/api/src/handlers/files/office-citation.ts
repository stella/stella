import { Result } from "better-result";
import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { findOfficeEvidenceBlock } from "@/api/lib/files/office-evidence";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "upload_mechanics" },
  params: workspaceParams({
    blockId: t.String({
      maxLength: 64,
      pattern: "^(?:pptx|xlsx)-[0-9a-f]{16}$",
    }),
    entityId: tSafeId("entity"),
    fieldId: tSafeId("field"),
  }),
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({
    params: { blockId, entityId, fieldId },
    scopedDb,
    session,
    workspaceId,
  }) {
    const evidence = yield* Result.await(
      Result.tryPromise(
        async () =>
          await findOfficeEvidenceBlock({
            blockId,
            entityId,
            fieldId,
            organizationId: session.activeOrganizationId,
            scopedDb,
            workspaceId,
          }),
      ),
    );
    if (!evidence) {
      return yield* Result.err(
        new HandlerError({
          message: "Office citation not found",
          status: 404,
        }),
      );
    }
    return Result.ok({
      locator: evidence.block.locator,
      source: evidence.source,
    });
  },
);
