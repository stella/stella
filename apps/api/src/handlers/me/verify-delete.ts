import { Result } from "better-result";
import { t } from "elysia";

import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import {
  checkUserOrganizationOwnership,
  getUserEmail,
  verifyAndDeleteUser,
} from "@/api/lib/delete-account";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const deleteAccountVerifyBody = t.Object({
  code: t.String({ minLength: 6, maxLength: 6 }),
  reassignments: t.Optional(
    t.Array(
      t.Object({
        entityId: tSafeId("entity"),
        reassignedUserId: tUserId,
      }),
    ),
  ),
});

const config = {
  mcp: { type: "internal", reason: "account_lifecycle" },
  body: deleteAccountVerifyBody,
} satisfies SessionHandlerConfig;

const deleteAccountVerify = createSafeSessionHandler(
  config,
  async function* (ctx) {
    const currentUserId = ctx.user.id;
    const { code, reassignments } = ctx.body;

    // 1. Fetch user details to get email
    const emailStr = yield* Result.await(getUserEmail(currentUserId));

    // 2. Double-check if the user is the sole owner of any organization at the moment of deletion
    const ownershipCheck = yield* Result.await(
      checkUserOrganizationOwnership(currentUserId),
    );

    if (ownershipCheck.isSoleOwner) {
      return Result.err(
        new HandlerError({
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
