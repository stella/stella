import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { linkConflictCheckMatter } from "@/api/lib/conflict-check/operation";
import { resourceIdSchema } from "@/api/lib/custom-schema";

const config = {
  contract: "patch",
  description:
    "Link a conflict check to the matter it was run for. The caller must be " +
    "able to open the matter; a check links to one matter at most.",
  permissions: { conflictCheck: ["run"], workspace: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "contact_directory",
    consumesServices: false,
  },
  params: v.object({
    checkId: resourceIdSchema("conflictCheck"),
    workspaceId: resourceIdSchema("workspace"),
  }),
} satisfies HandlerConfig;

const linkConflictCheckMatterHandler = createSafeRootHandler(
  config,
  async function* ({
    params: { checkId, workspaceId },
    recordAuditEvent,
    safeDb,
    session,
  }) {
    const view = yield* Result.await(
      linkConflictCheckMatter({
        safeDb,
        organizationId: session.activeOrganizationId,
        checkId,
        workspaceId,
        recordAuditEvent,
      }),
    );
    return Result.ok(view);
  },
);

export default linkConflictCheckMatterHandler;
