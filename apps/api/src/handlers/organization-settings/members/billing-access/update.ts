import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { setMemberBillingAccess } from "@/api/lib/auth";

export const createMemberBillingAccessHandler = (
  changeAccess: typeof setMemberBillingAccess = setMemberBillingAccess,
) =>
  createSafeRootHandler(
    {
      contract: "patch",
      description:
        "Set a member's additional billing visibility in the active organization. Only owners and admins may change it. Their role grants billing visibility independently of this field.",
      permissions: { member: ["update"] },
      accountAccess: ACCOUNT_ACCESS.standard,
      featureAccess: { featureId: "time-billing", type: "required" },
      mcp: {
        type: "capability",
        reason: "billing_admin",
        consumesServices: false,
      },
      params: v.strictObject({
        memberId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      }),
      body: v.strictObject({ billingAccess: v.boolean() }),
    },
    async function* ({ session, user, params, body, recordAuditEvent }) {
      return Result.ok(
        yield* Result.await(
          changeAccess({
            organizationId: session.activeOrganizationId,
            actorUserId: user.id,
            targetMemberId: params.memberId,
            billingAccess: body.billingAccess,
            recordAuditEvent,
          }),
        ),
      );
    },
  );

export default createMemberBillingAccessHandler();
