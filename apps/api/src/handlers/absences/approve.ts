import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { transitionAbsence } from "@/api/lib/billing/absences";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const approve = createSafeRootHandler(
  {
    description:
      "Approve a requested absence as an organization owner or admin. Supply its current version from the approval queue; overlapping approved absences for the same owner are refused. An optional comment records the decision.",
    permissions: { timeEntry: ["approve"] },
    access: "write",
    mcp: { type: "capability", reason: "billing_admin" },
    params: t.Object({ id: tSafeId("absence") }),
    body: t.Object(
      {
        version: t.Integer({ minimum: 1 }),
        comment: t.Optional(
          t.String({ maxLength: LIMITS.timeEntryReturnCommentMaxLength }),
        ),
      },
      { additionalProperties: false },
    ),
  },
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    params,
    body,
    recordAuditEvent,
  }) {
    const payload = yield* Result.await(
      transitionAbsence({
        safeDb,
        organizationId: session.activeOrganizationId,
        actorUserId: user.id,
        memberRole,
        id: params.id,
        body: {
          action: "approve",
          version: body.version,
          ...(body.comment !== undefined ? { comment: body.comment } : {}),
        },
        recordAuditEvent,
      }),
    );
    return Result.ok(payload);
  },
);
export default approve;
