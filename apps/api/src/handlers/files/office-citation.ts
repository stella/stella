import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { findOfficeEvidenceBlock } from "@/api/lib/files/office-evidence";

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "upload_mechanics" },
  access: "read",
  params: workspaceParams({
    blockId: v.pipe(
      v.string(),
      v.maxLength(64),
      v.regex(/^(?:pptx|xlsx)-[0-9a-f]{16}$/u),
    ),
    entityId: resourceIdSchema("entity"),
    fieldId: resourceIdSchema("field"),
  }),
} satisfies WorkspaceHandlerConfig;

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
