import { panic } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { correspondenceUserHasAccess } from "@/api/lib/email/correspondence/access";
import type { SenderMembership } from "@/api/lib/email/inbound/acceptance";

export type InboundTransaction = Pick<
  Transaction,
  "select" | "insert" | "execute" | "rollback"
>;

type ResolveInboundSenderOptions = {
  tx: InboundTransaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  sender: string;
  receivedAt: string;
  primaryUserId: SafeId<"user"> | null;
};

export const resolveInboundSender = async ({
  tx,
  organizationId,
  workspaceId,
  sender,
  receivedAt,
  primaryUserId,
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
    .for("update");
  const approval = approvals.at(0);
  if (!approval) {
    if (
      primaryUserId &&
      (await correspondenceUserHasAccess({
        tx,
        organizationId,
        workspaceId,
        userId: primaryUserId,
      }))
    ) {
      return {
        status: "allowed",
        filer: { type: "user", userId: primaryUserId, filedAt: receivedAt },
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
        !(await correspondenceUserHasAccess({
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

// The account row is locked in the worker's owner phase: the request role has
// read-only access to auth users and cannot acquire this row lock.
export const lookupInboundPrimaryAccount = async ({
  tx,
  organizationId,
  sender,
}: {
  tx: InboundTransaction;
  organizationId: SafeId<"organization">;
  sender: string;
}) => {
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
  return primary.at(0)?.id ?? null;
};
