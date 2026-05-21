import { and, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";

import { createSafeDb } from "@/api/db";
import type { SafeDb } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import { rootDb, rlsDb } from "@/api/db/root";
import {
  desktopEditHandoffs,
  desktopEditSessions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  canUseDesktopEditSession,
  hashDesktopEditHandoffToken,
} from "@/api/lib/desktop-edit-sessions";

export type ConsumedDesktopEditHandoff = {
  apiBaseUrl: string;
  createdBy: string;
  id: SafeId<"desktopEditHandoff">;
  entityId: SafeId<"entity">;
  forceTakeover: boolean;
  linkedAccount: {
    email: string;
    name: string | null;
    verifiedAt: string;
  } | null;
  propertyId: SafeId<"property">;
  workspaceId: SafeId<"workspace">;
};

export const consumeDesktopEditHandoff = async (
  handoffToken: string,
): Promise<ConsumedDesktopEditHandoff | null> => {
  const now = new Date();
  const tokenHash = hashDesktopEditHandoffToken(handoffToken);

  const rows = await rootDb
    .update(desktopEditHandoffs)
    .set({ consumedAt: now })
    .where(
      and(
        eq(desktopEditHandoffs.tokenHash, tokenHash),
        isNull(desktopEditHandoffs.consumedAt),
        gte(desktopEditHandoffs.expiresAt, now),
      ),
    )
    .returning({
      apiBaseUrl: desktopEditHandoffs.apiBaseUrl,
      createdBy: desktopEditHandoffs.createdBy,
      id: desktopEditHandoffs.id,
      entityId: desktopEditHandoffs.entityId,
      forceTakeover: desktopEditHandoffs.forceTakeover,
      linkedAccount: desktopEditHandoffs.linkedAccount,
      propertyId: desktopEditHandoffs.propertyId,
      workspaceId: desktopEditHandoffs.workspaceId,
    });

  return rows.at(0) ?? null;
};

export const markDesktopEditHandoffOpened = async ({
  handoffId,
  handoffToken,
  sessionId,
}: {
  handoffId: SafeId<"desktopEditHandoff">;
  handoffToken: string;
  sessionId: SafeId<"desktopEditSession">;
}): Promise<boolean> => {
  const tokenHash = hashDesktopEditHandoffToken(handoffToken);
  const rows = await rootDb
    .update(desktopEditHandoffs)
    .set({
      desktopSessionId: sessionId,
      openedAt: new Date(),
    })
    .where(
      and(
        eq(desktopEditHandoffs.id, handoffId),
        eq(desktopEditHandoffs.tokenHash, tokenHash),
        isNotNull(desktopEditHandoffs.consumedAt),
        sql`exists (
          select 1
          from ${desktopEditSessions}
          where ${desktopEditSessions.id} = ${sessionId}
            and ${desktopEditSessions.workspaceId} = ${desktopEditHandoffs.workspaceId}
        )`,
      ),
    )
    .returning({ id: desktopEditHandoffs.id });

  return rows.at(0) !== undefined;
};

export const readDesktopEditHandoffAccess = async ({
  createdBy,
  workspaceId,
}: {
  createdBy: string;
  workspaceId: SafeId<"workspace">;
}) => {
  const rows = await rootDb
    .select({
      organizationId: workspaces.organizationId,
      organizationRole: member.role,
      workspaceMemberId: workspaceMembers.id,
    })
    .from(workspaces)
    .leftJoin(
      member,
      and(
        eq(member.userId, createdBy),
        eq(member.organizationId, workspaces.organizationId),
      ),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, createdBy),
        eq(workspaceMembers.workspaceId, workspaceId),
      ),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const access = rows.at(0);
  if (!access) {
    return null;
  }

  return {
    canUseDesktopEditSession: canUseDesktopEditSession({
      organizationRole: access.organizationRole,
      workspaceMemberId: access.workspaceMemberId,
    }),
    organizationId: access.organizationId,
  };
};

export const createDesktopEditHandoffSafeDb = ({
  organizationId,
  userId,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}): SafeDb => createSafeDb(rlsDb, [workspaceId], organizationId, userId);
