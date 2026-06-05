import { and, eq } from "drizzle-orm";

import { roles } from "@stll/permissions";

import type { ScopedDb } from "@/api/db";
import { member, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  desktopEditSessions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { liveDesktopEditSessionPredicates } from "@/api/lib/desktop-edit-session-predicates";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

type AuthorizedDesktopEditSession = {
  fileName: string;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

type DesktopEditSessionAuthorizationResult =
  | {
      status: "authorized";
      value: AuthorizedDesktopEditSession;
    }
  | {
      status: "missing";
    }
  | {
      status: "token-expired";
    }
  | {
      status: "token-mismatch";
    }
  | {
      status: "permission-revoked";
    };

/** Session tokens expire after 24 hours. Each checkpoint extends by this amount. */
export const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export const computeTokenExpiresAt = () =>
  new Date(Date.now() + SESSION_TOKEN_TTL_MS);

const SESSION_TOKEN_PART_LENGTH = 32;

export const createDesktopEditSessionToken = () =>
  Bun.randomUUIDv7().replaceAll("-", "").slice(0, SESSION_TOKEN_PART_LENGTH) +
  Bun.randomUUIDv7().replaceAll("-", "").slice(0, SESSION_TOKEN_PART_LENGTH);

export const hashDesktopEditSessionToken = (sessionToken: string) =>
  new Bun.CryptoHasher("sha256").update(sessionToken).digest("hex");

export const DESKTOP_EDIT_SESSION_LIVENESS_REFRESH_INTERVAL_MS =
  SESSION_TOKEN_TTL_MS / 4;

export const refreshDesktopEditSessionLiveness = async ({
  sessionId,
  sessionToken,
  userId,
}: {
  sessionId: SafeId<"desktopEditSession">;
  sessionToken: string;
  userId: SafeId<"user">;
}): Promise<boolean> => {
  const sessionTokenHash = hashDesktopEditSessionToken(sessionToken);

  const updatedSessions = await rootDb
    .update(desktopEditSessions)
    .set({ tokenExpiresAt: computeTokenExpiresAt() })
    .where(
      and(
        eq(desktopEditSessions.id, sessionId),
        eq(desktopEditSessions.createdBy, userId),
        eq(desktopEditSessions.sessionTokenHash, sessionTokenHash),
        ...liveDesktopEditSessionPredicates(new Date()),
      ),
    )
    .returning({ id: desktopEditSessions.id });

  return updatedSessions.at(0) !== undefined;
};

/** Handoff tokens are only for browser-to-desktop launch. */
export const DESKTOP_EDIT_HANDOFF_TTL_MS = 2 * 60 * 1000;

export const computeDesktopEditHandoffExpiresAt = () =>
  new Date(Date.now() + DESKTOP_EDIT_HANDOFF_TTL_MS);

export const createDesktopEditHandoffToken = createDesktopEditSessionToken;

export const hashDesktopEditHandoffToken = hashDesktopEditSessionToken;

export const DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE =
  "desktop_edit_session_taken_over";
export const DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE =
  "Desktop editing moved to another device. This local copy is preserved.";

const ADMIN_BYPASS_ROLES = new Set<MemberRole>(["owner", "admin"]);

export const canUseDesktopEditSession = ({
  organizationRole,
  workspaceMemberId,
}: {
  organizationRole: string | null;
  workspaceMemberId: string | null;
}) => {
  if (!organizationRole || !isMemberRole(organizationRole)) {
    return false;
  }

  const hasEntityUpdate = roles[organizationRole].authorize({
    entity: ["update"],
  }).success;
  const hasWorkspaceAccess =
    ADMIN_BYPASS_ROLES.has(organizationRole) || workspaceMemberId !== null;

  return hasEntityUpdate && hasWorkspaceAccess;
};

export const authorizeDesktopEditSession = async ({
  sessionId,
  sessionToken,
}: {
  sessionId: SafeId<"desktopEditSession">;
  sessionToken: string;
}): Promise<DesktopEditSessionAuthorizationResult> => {
  const tokenHash = hashDesktopEditSessionToken(sessionToken);

  const rows = await rootDb
    .select({
      createdBy: desktopEditSessions.createdBy,
      fileName: desktopEditSessions.fileName,
      organizationId: workspaces.organizationId,
      organizationRole: member.role,
      sessionStatus: desktopEditSessions.status,
      sessionTokenHash: desktopEditSessions.sessionTokenHash,
      tokenExpiresAt: desktopEditSessions.tokenExpiresAt,
      workspaceMemberId: workspaceMembers.id,
      workspaceId: desktopEditSessions.workspaceId,
    })
    .from(desktopEditSessions)
    .innerJoin(workspaces, eq(desktopEditSessions.workspaceId, workspaces.id))
    .leftJoin(
      member,
      and(
        eq(member.userId, desktopEditSessions.createdBy),
        eq(member.organizationId, workspaces.organizationId),
      ),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, desktopEditSessions.createdBy),
        eq(workspaceMembers.workspaceId, desktopEditSessions.workspaceId),
      ),
    )
    .where(eq(desktopEditSessions.id, sessionId))
    .limit(1);

  const session = rows.at(0);
  if (!session || session.sessionStatus !== "open") {
    return {
      status: "missing",
    };
  }

  if (session.sessionTokenHash !== tokenHash) {
    return {
      status: "token-mismatch",
    };
  }

  if (session.tokenExpiresAt < new Date()) {
    return {
      status: "token-expired",
    };
  }

  if (
    !canUseDesktopEditSession({
      organizationRole: session.organizationRole,
      workspaceMemberId: session.workspaceMemberId,
    })
  ) {
    return {
      status: "permission-revoked",
    };
  }

  const userId = brandPersistedUserId(session.createdBy);

  return {
    status: "authorized",
    value: {
      fileName: session.fileName,
      organizationId: session.organizationId,
      scopedDb: createRootScopedDb({
        organizationId: session.organizationId,
        userId,
        workspaceIds: [session.workspaceId],
      }),
      userId,
      workspaceId: session.workspaceId,
    },
  };
};

export const readDesktopEditSessionEventState = async (
  sessionId: SafeId<"desktopEditSession">,
) => {
  const sessions = await rootDb
    .select({
      organizationRole: member.role,
      workspaceMemberId: workspaceMembers.id,
    })
    .from(desktopEditSessions)
    .innerJoin(workspaces, eq(desktopEditSessions.workspaceId, workspaces.id))
    .leftJoin(
      member,
      and(
        eq(member.userId, desktopEditSessions.createdBy),
        eq(member.organizationId, workspaces.organizationId),
      ),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, desktopEditSessions.createdBy),
        eq(workspaceMembers.workspaceId, desktopEditSessions.workspaceId),
      ),
    )
    .where(
      and(
        eq(desktopEditSessions.id, sessionId),
        eq(desktopEditSessions.status, "open"),
      ),
    )
    .limit(1);

  const session = sessions.at(0);
  if (
    !session ||
    !canUseDesktopEditSession({
      organizationRole: session.organizationRole,
      workspaceMemberId: session.workspaceMemberId,
    })
  ) {
    return null;
  }

  const pendingRequests = await rootDb
    .select({
      requestedByName: user.name,
      requestedAt: desktopEditSessions.takeoverRequestedAt,
    })
    .from(desktopEditSessions)
    .innerJoin(workspaces, eq(desktopEditSessions.workspaceId, workspaces.id))
    .leftJoin(
      member,
      and(
        eq(desktopEditSessions.takeoverRequestedBy, member.userId),
        eq(member.organizationId, workspaces.organizationId),
      ),
    )
    .leftJoin(user, eq(member.userId, user.id))
    .where(eq(desktopEditSessions.id, sessionId))
    .limit(1);

  const pendingRequest = pendingRequests.at(0);

  return {
    pendingRequest: pendingRequest ?? null,
  };
};
