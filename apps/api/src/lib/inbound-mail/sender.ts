import { panic } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_ACCESS_MODE,
  SETTING_WORKSPACE_IDS,
  stellaAuthorizedWorkspaces,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import {
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
  workspaceMembers,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { SenderMembership } from "@/api/lib/inbound-mail/acceptance";

export type InboundTransaction = Pick<
  Transaction,
  "select" | "insert" | "execute"
>;

type ResolveUserAccessOptions = {
  tx: InboundTransaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: string;
};

const userHasAccess = async ({
  tx,
  organizationId,
  workspaceId,
  userId,
}: ResolveUserAccessOptions) => {
  // Membership/assignment locks survive through the correspondence write. The
  // shared authorization view remains the authority for admin and matter scope.
  const membership = await tx
    .select({ id: member.id })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1)
    .for("share");
  if (membership.length === 0) {
    return false;
  }
  await tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1)
    .for("share");
  await tx.execute(
    sql`select set_config(${SETTING_USER_ID}, ${userId}, true), set_config(${SETTING_ORGANIZATION_ID}, ${organizationId}, true), set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${WORKSPACE_ACCESS_MODE.membership}, true), set_config(${SETTING_WORKSPACE_IDS}, '{}', true)`,
  );
  const accessible = await tx
    .select({ id: stellaAuthorizedWorkspaces.authorizedWorkspaceId })
    .from(stellaAuthorizedWorkspaces)
    .where(
      and(
        eq(stellaAuthorizedWorkspaces.authorizedWorkspaceId, workspaceId),
        eq(stellaAuthorizedWorkspaces.workspaceStatus, "active"),
      ),
    )
    .limit(1);
  return accessible.length === 1;
};

type ResolveInboundSenderOptions = {
  tx: InboundTransaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  sender: string;
  receivedAt: string;
};

export const resolveInboundSender = async ({
  tx,
  organizationId,
  workspaceId,
  sender,
  receivedAt,
}: ResolveInboundSenderOptions): Promise<SenderMembership> => {
  const approvals = await tx
    .select()
    .from(correspondenceAllowedSenders)
    .where(
      and(
        eq(correspondenceAllowedSenders.organizationId, organizationId),
        eq(correspondenceAllowedSenders.address, sender),
        isNull(correspondenceAllowedSenders.revokedAt),
      ),
    )
    .limit(1)
    .for("share");
  const approval = approvals.at(0);
  if (!approval) {
    const primary = await tx
      .select({ id: user.id })
      .from(user)
      .innerJoin(
        member,
        and(
          eq(member.userId, user.id),
          eq(member.organizationId, organizationId),
        ),
      )
      .where(and(eq(user.email, sender), eq(user.emailVerified, true)))
      .limit(1)
      .for("share", { of: user });
    const account = primary.at(0);
    if (
      account &&
      (await userHasAccess({
        tx,
        organizationId,
        workspaceId,
        userId: account.id,
      }))
    ) {
      return {
        status: "allowed",
        filer: { type: "user", userId: account.id, filedAt: receivedAt },
      };
    }
    return { status: "denied" };
  }
  switch (approval.scope) {
    case "organization":
      break;
    case "matters": {
      const scope = await tx
        .select({ id: correspondenceAllowedSenderMatters.id })
        .from(correspondenceAllowedSenderMatters)
        .where(
          and(
            eq(
              correspondenceAllowedSenderMatters.organizationId,
              organizationId,
            ),
            eq(correspondenceAllowedSenderMatters.workspaceId, workspaceId),
            eq(correspondenceAllowedSenderMatters.allowedSenderId, approval.id),
          ),
        )
        .limit(1)
        .for("share");
      if (scope.length === 0) {
        return { status: "denied" };
      }
      break;
    }
    default: {
      approval.scope satisfies never;
      return panic("Unhandled sender approval scope");
    }
  }
  switch (approval.kind) {
    case "verified_alias":
      if (
        !approval.ownerUserId ||
        !(await userHasAccess({
          tx,
          organizationId,
          workspaceId,
          userId: approval.ownerUserId,
        }))
      ) {
        return { status: "denied" };
      }
      return {
        status: "allowed",
        filer: {
          type: "user",
          userId: approval.ownerUserId,
          filedAt: receivedAt,
        },
      };
    case "shared_mailbox":
      if (!approval.approvedBy) {
        return { status: "denied" };
      }
      return {
        status: "allowed",
        filer: {
          type: "shared_mailbox",
          allowedSenderId: approval.id,
          address: approval.address,
          approvedBy: approval.approvedBy,
          filedAt: receivedAt,
        },
      };
    default: {
      approval.kind satisfies never;
      return panic("Unhandled sender approval kind");
    }
  }
};
