import { Result } from "better-result";
import * as v from "valibot";

import {
  filePartIdSchema,
  parseFilePartId,
} from "@stll/api-contract/file-parts";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readEmailFile } from "@/api/lib/files/read-email-file";

const config = {
  contract: "patch",
  contentDelivery: { type: "audited" },
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "upload_mechanics" },
  query: v.object({
    /** An email that is a part of the file, such as `message:3`. */
    part: v.optional(filePartIdSchema),
  }),
  params: workspaceParams({ fieldId: resourceIdSchema("field") }),
} satisfies WorkspaceHandlerConfig;

export default createSafeHandler(
  config,
  async function* ({
    params: { fieldId },
    query: { part: partId },
    scopedDb,
    workspaceId,
    session,
    recordAuditEvent,
  }) {
    const part = partId === undefined ? undefined : parseFilePartId(partId);
    if (part === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "not_found",
          message: "The file has no such part",
        }),
      );
    }
    const read = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readEmailFile({
            scopedDb,
            workspaceId,
            fieldId,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
            part,
          }),
      ),
    );
    return Result.ok(yield* read);
  },
);
