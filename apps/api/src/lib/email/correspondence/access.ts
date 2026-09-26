import { panic } from "better-result";
import { and, eq, sql, isNull } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
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
  workspaceMembers,
  workspaces,
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type AccessTransaction = Pick<Transaction, "select" | "execute">;

type ResolveUserAccessOptions = {
  tx: AccessTransaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: string;
};

export const correspondenceUserHasAccess = async ({
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

export type CorrespondenceActor =
  | { type: "user"; userId: SafeId<"user"> }
  | {
      type: "shared_mailbox";
      allowedSenderId: SafeId<"correspondenceAllowedSender">;
    };

export const assertCorrespondenceAccess = async ({
  tx,
  workspaceId,
  organizationId,
  filer,
}: {
  tx: AccessTransaction;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  filer: CorrespondenceActor;
}) => {
  const matters = await tx
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, organizationId),
      ),
    )
    .limit(1)
    .for("update");
  if (matters.at(0)?.status !== "active") {
    throw new HandlerError({
      status: 403,
      message: "Matter access required",
    });
  }
  switch (filer.type) {
    case "user": {
      if (
        !(await correspondenceUserHasAccess({
          tx,
          organizationId,
          workspaceId,
          userId: filer.userId,
        }))
      ) {
        throw new HandlerError({
          status: 403,
          message: "Matter access required",
        });
      }
      break;
    }
    case "shared_mailbox": {
      const [approval] = await tx
        .select({ scope: correspondenceAllowedSenders.scope })
        .from(correspondenceAllowedSenders)
        .where(
          and(
            eq(correspondenceAllowedSenders.id, filer.allowedSenderId),
            eq(correspondenceAllowedSenders.organizationId, organizationId),
            eq(correspondenceAllowedSenders.kind, "shared_mailbox"),
            isNull(correspondenceAllowedSenders.revokedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (approval === undefined) {
        throw new HandlerError({
          status: 403,
          message: "Mailbox approval required",
        });
      }
      if (approval.scope === "matters") {
        const [scope] = await tx
          .select({ id: correspondenceAllowedSenderMatters.id })
          .from(correspondenceAllowedSenderMatters)
          .where(
            and(
              eq(
                correspondenceAllowedSenderMatters.allowedSenderId,
                filer.allowedSenderId,
              ),
              eq(correspondenceAllowedSenderMatters.workspaceId, workspaceId),
              eq(
                correspondenceAllowedSenderMatters.organizationId,
                organizationId,
              ),
            ),
          )
          .limit(1)
          .for("share");
        if (scope === undefined) {
          throw new HandlerError({
            status: 403,
            message: "Mailbox not approved for matter",
          });
        }
      }
      break;
    }
    default: {
      filer satisfies never;
      return panic("Unhandled correspondence filer");
    }
  }
};
