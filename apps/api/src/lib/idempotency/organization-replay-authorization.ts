import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type OrganizationReplayAuthorizationOptions = {
  scopedDb: ScopedDb;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
};

/** For creates whose entire resource scope is the caller's organization. */
export const authorizeOrganizationReplay = async ({
  scopedDb,
  session,
  user,
}: OrganizationReplayAuthorizationOptions) =>
  await scopedDb(async (tx) => {
    const membership = await tx
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, session.activeOrganizationId),
          eq(member.userId, user.id),
        ),
      )
      .limit(1);
    if (membership.length === 0) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Organization membership required",
        }),
      );
    }
    return Result.ok(undefined);
  });
