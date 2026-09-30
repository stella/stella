import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { transitionAbsence } from "@/api/lib/billing/absences";
import { tSafeId } from "@/api/lib/custom-schema";

const cancel = createSafeRootHandler(
  {
    description:
      "Cancel your own absence while it is requested. Supply its current version from your absence list; decided absences cannot be cancelled.",
    permissions: { timeEntry: ["update"] },
    access: "write",
    mcp: { type: "capability", reason: "billing_admin" },
    params: t.Object({ id: tSafeId("absence") }),
    body: t.Object(
      { version: t.Integer({ minimum: 1 }) },
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
        body: { action: "cancel", version: body.version },
        recordAuditEvent,
      }),
    );
    return Result.ok(payload);
  },
);
export default cancel;
