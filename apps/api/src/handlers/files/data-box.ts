import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { readDataBoxFile } from "@/api/lib/files/read-data-box-file";

const config = {
  contract: "patch",
  contentDelivery: { type: "audited" },
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "upload_mechanics" },
  params: workspaceParams({ fieldId: resourceIdSchema("field") }),
} satisfies WorkspaceHandlerConfig;

export default createSafeHandler(
  config,
  async function* ({
    params: { fieldId },
    scopedDb,
    workspaceId,
    session,
    recordAuditEvent,
  }) {
    const read = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readDataBoxFile({
            scopedDb,
            workspaceId,
            fieldId,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
          }),
      ),
    );
    return Result.ok(yield* read);
  },
);
