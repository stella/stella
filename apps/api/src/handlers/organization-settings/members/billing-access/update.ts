import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { setMemberBillingAccess } from "@/api/lib/auth";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";

export const createMemberBillingAccessHandler = (
  changeAccess: typeof setMemberBillingAccess = setMemberBillingAccess,
) =>
  createSafeRootHandler(
    {
      contract: "patch",
      // The member's permissions change; their open role reads refresh.
      realtime: organizationResourceSetUpdates(RESOURCE_TYPE.ORGANIZATION),
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
    async function* ({
      safeDb,
      session,
      user,
      params,
      body,
      recordAuditEvent,
    }) {
      return Result.ok(
        yield* Result.await(
          changeAccess({
            safeDb,
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

const updateMemberBillingAccess = createMemberBillingAccessHandler();

declareAggregateMutation(updateMemberBillingAccess, {
  type: "independent",
  reason:
    "Updates one member attribute. The scoped transaction locks the actor and target rows in ID order and rechecks authority under those locks; no aggregate state spans members.",
});

export default updateMemberBillingAccess;
