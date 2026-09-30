import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { transitionAbsence } from "@/api/lib/billing/absences";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const reject = createSafeRootHandler(
  {
    description:
      "Reject a requested absence as an organization owner or admin with a required nonblank comment. Supply its current version from the approval queue.",
    permissions: { timeEntry: ["approve"] },
    access: "write",
    mcp: { type: "capability", reason: "billing_admin" },
    params: t.Object({ id: tSafeId("absence") }),
    body: t.Object(
      {
        version: t.Integer({ minimum: 1 }),
        comment: t.String({
          minLength: 1,
          maxLength: LIMITS.timeEntryReturnCommentMaxLength,
          pattern: "\\S",
        }),
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
          action: "reject",
          version: body.version,
          comment: body.comment,
        },
        recordAuditEvent,
      }),
    );
    return Result.ok(payload);
  },
);
export default reject;
