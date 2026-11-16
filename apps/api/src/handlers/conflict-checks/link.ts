import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { linkConflictCheckMatter } from "@/api/lib/conflict-check/operation";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  description:
    "Link a conflict check to the matter it was run for. Only the check's " +
    "runner or an owner or administrator may link it, and only to a matter " +
    "they can open; a check links to one matter at most.",
  permissions: { conflictCheck: ["run"], workspace: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  // No web view lists conflict checks yet; the caller reads its own result.
  realtime: noResourceSetUpdates(
    "conflict checks have no open-tab list to refresh",
  ),
  featureAccess: { featureId: "conflict-check", type: "required" },
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
    memberRole,
    params: { checkId, workspaceId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const view = yield* Result.await(
      linkConflictCheckMatter({
        safeDb,
        organizationId: session.activeOrganizationId,
        checkId,
        workspaceId,
        userId: user.id,
        isReviewer: hasMemberPermission(memberRole, {
          conflictCheck: ["review"],
        }),
        recordAuditEvent,
      }),
    );
    return Result.ok(view);
  },
);

declareAggregateMutation(linkConflictCheckMatterHandler, {
  type: "independent",
  reason:
    "One link row per check, keyed by the check; the upsert converges on the last matter linked.",
});

export default linkConflictCheckMatterHandler;
