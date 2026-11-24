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
import { readFilePartList } from "@/api/lib/files/file-part";

const config = {
  contract: "patch",
  contentDelivery: { type: "audited" },
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "upload_mechanics" },
  query: v.object({
    /** A part that is itself a container, such as `member:2`. */
    part: filePartIdSchema,
  }),
  params: workspaceParams({ fieldId: resourceIdSchema("field") }),
} satisfies WorkspaceHandlerConfig;

/**
 * The files of a part that is itself a container (an email in an archive,
 * an archive in a data-box message), each opening through the file's part
 * link by the path this list gives it.
 */
export const readFilePartListEndpoint = createSafeHandler(
  config,
  async function* ({
    params: { fieldId },
    query: { part: partId },
    scopedDb,
    workspaceId,
    session,
    recordAuditEvent,
  }) {
    const part = parseFilePartId(partId);
    if (part === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "not_found",
          message: "The file has no such part",
        }),
      );
    }
    const result = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readFilePartList({
            fieldId,
            scopedDb,
            workspaceId,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
            part,
          }),
      ),
    );
    return Result.ok(yield* result);
  },
);
