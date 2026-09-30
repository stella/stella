import { Result } from "better-result";

import { isOrganizationManagementRole } from "@stll/permissions";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { absenceListQuerySchema, listAbsencePage } from "../list-query";

const approvalQueue = createSafeRootHandler(
  {
    description:
      "List requested absences awaiting an organization owner or admin decision. Each row carries the current version for approve or reject and capacity in days. Follow nextCursor for the next bounded page.",
    permissions: { timeEntry: ["approve"] },
    access: "read",
    mcp: { type: "capability", reason: "billing_admin" },
    query: absenceListQuerySchema,
  },
  async function* ({ safeDb, session, memberRole, query }) {
    if (!isOrganizationManagementRole(memberRole.role)) {
      return Result.err(
        new HandlerError({
          status: 403,
          code: "absence_manager_required",
          message:
            "Only organization owners and admins can read the absence approval queue",
          hint: "List your own absences instead.",
        }),
      );
    }
    const page = yield* Result.await(
      listAbsencePage({
        safeDb,
        organizationId: session.activeOrganizationId,
        selection: { type: "approval_queue" },
        query,
      }),
    );
    return Result.ok(page);
  },
);
export default approvalQueue;
