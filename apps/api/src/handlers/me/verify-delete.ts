import { Result } from "better-result";
import * as v from "valibot";

import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { checkDemoAccountOperation } from "@/api/lib/auth/demo-account";
import { resourceIdSchema, userIdSchema } from "@/api/lib/custom-schema";
import {
  ACCOUNT_DELETION_ERROR_CODE,
  checkUserOrganizationOwnership,
  getUserEmail,
  ORGANIZATION_OWNERSHIP,
  verifyAndDeleteUser,
} from "@/api/lib/delete-account";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteAccountVerifyBody = v.object({
  code: v.pipe(v.string(), v.minLength(6), v.maxLength(6)),
  reassignments: v.optional(
    v.array(
      v.object({
        entityId: resourceIdSchema("entity"),
        reassignedUserId: userIdSchema,
      }),
    ),
  ),
});

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "account_lifecycle" },
  body: deleteAccountVerifyBody,
} satisfies SessionHandlerConfig;

const deleteAccountVerify = createSafeSessionHandler(
  config,
  async function* (ctx) {
    yield* checkDemoAccountOperation(ctx.user.email);
    const currentUserId = ctx.user.id;
    const { code, reassignments } = ctx.body;

    // 1. Fetch user details to get email
    const emailStr = yield* Result.await(getUserEmail(currentUserId));

    // 2. Double-check if the user is the sole owner of any organization at the moment of deletion
    const ownershipCheck = yield* Result.await(
      checkUserOrganizationOwnership(currentUserId),
    );

    if (ownershipCheck.type === ORGANIZATION_OWNERSHIP.soleOwner) {
      return Result.err(
        new HandlerError({
          code: ACCOUNT_DELETION_ERROR_CODE.soleOwner,
          status: 400,
          message: `Cannot delete account because you are the sole owner of organization "${ownershipCheck.orgName}". Please transfer ownership or delete the organization first.`,
        }),
      );
    }

    // 3. Verify and delete the user
    yield* Result.await(
      verifyAndDeleteUser(currentUserId, emailStr, code, reassignments),
    );

    return Result.ok({ success: true });
  },
);

export default deleteAccountVerify;
