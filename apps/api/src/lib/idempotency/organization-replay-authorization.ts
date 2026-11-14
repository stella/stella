import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { PermissionInput } from "@stll/permissions";

import { member } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { lockMemberAccessRow } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  withCurrentMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

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

type OrganizationPermissionReplayOptions =
  OrganizationReplayAuthorizationOptions & {
    memberRole: AuthorizedMemberRole;
  };

/** Replays spend the credential against the member's current organization role. */
export const authorizeOrganizationPermissionReplay = async (
  { scopedDb, session, user, memberRole }: OrganizationPermissionReplayOptions,
  permissions: PermissionInput,
) =>
  await scopedDb(async (tx) => {
    const current = await lockMemberAccessRow({
      tx,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      mode: "share",
    });
    if (
      current === undefined ||
      !isMemberRole(current.role) ||
      !hasMemberPermission(
        withCurrentMemberRole(memberRole, current.role),
        permissions,
      )
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Organization permission required",
        }),
      );
    }
    return Result.ok(undefined);
  });
