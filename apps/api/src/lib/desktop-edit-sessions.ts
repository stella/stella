import { and, eq } from "drizzle-orm";

import { Temporal, DAY_IN_MS } from "@stll/time";

import { member, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  desktopEditSessions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { DesktopEditFileType } from "@/api/lib/desktop-edit-file-types";
import { liveDesktopEditSessionPredicates } from "@/api/lib/desktop-edit-session-predicates";
import {
  createOpaqueToken,
  hashOpaqueToken,
} from "@/api/lib/entities/opaque-tokens";
import { canWriteWorkspaceEntities } from "@/api/lib/entities/workspace-entity-write-access";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

type AuthorizedDesktopEditSession = {
  entityId: SafeId<"entity">;
  fileName: string;
  fileType: DesktopEditFileType;
  organizationId: SafeId<"organization">;
  /**
   * Request scope for the session's creator, pinned to the session's
   * workspace. Open one short transaction per read or renewal; a stream must
   * not hold one for its lifetime.
   */
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

/** Session tokens expire after 24 hours. Each checkpoint extends by this amount.
 *  Fixed-duration TTL, not calendar math — `addDays` would make expiry drift
 *  by an hour across a DST transition. */
export const SESSION_TOKEN_TTL_MS = DAY_IN_MS;

export const computeTokenExpiresAt = () =>
  new Date(Temporal.Now.instant().epochMilliseconds + SESSION_TOKEN_TTL_MS);

export const createDesktopEditSessionToken = createOpaqueToken;

export const hashDesktopEditSessionToken = hashOpaqueToken;

export const DESKTOP_EDIT_SESSION_LIVENESS_REFRESH_INTERVAL_MS =
  SESSION_TOKEN_TTL_MS / 4;

/**
 * Extend a live session's token, in the session's own scoped transaction (see
 * {@link authorizeDesktopEditSession}). The creator, token and liveness
 * predicates still decide which row moves; the scope only bounds where it can
 * be.
 */
export const refreshDesktopEditSessionLiveness = async (
  tx: Pick<Transaction, "update">,
  {
    sessionId,
    sessionToken,
    userId,
  }: {
    sessionId: SafeId<"desktopEditSession">;
    sessionToken: string;
    userId: SafeId<"user">;
  },
): Promise<boolean> => {
  const sessionTokenHash = hashDesktopEditSessionToken(sessionToken);

  const updatedSessions = await tx
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
  new Date(
    Temporal.Now.instant().epochMilliseconds + DESKTOP_EDIT_HANDOFF_TTL_MS,
  );

export const createDesktopEditHandoffToken = createDesktopEditSessionToken;

export const hashDesktopEditHandoffToken = hashDesktopEditSessionToken;

export const DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE =
  "desktop_edit_session_taken_over";
export const DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE =
  "Desktop editing moved to another device. This local copy is preserved.";

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
      entityId: desktopEditSessions.entityId,
      fileName: desktopEditSessions.fileName,
      fileType: desktopEditSessions.fileType,
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
    !canWriteWorkspaceEntities({
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
      entityId: session.entityId,
      fileName: session.fileName,
      fileType: session.fileType,
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

/**
 * The session creator's current access and any pending takeover request, read
 * in the session's own scoped transaction (see
 * {@link authorizeDesktopEditSession}). That scope pins the session's
 * workspace, so row visibility alone would not notice a revoked membership:
 * the joined membership rows decide it here. The requester's name is joined
 * through their membership of the same organization, so a requester who has
 * since left reads as no name.
 */
export const readDesktopEditSessionEventState = async (
  tx: Pick<Transaction, "select">,
  sessionId: SafeId<"desktopEditSession">,
) => {
  const sessions = await tx
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
    !canWriteWorkspaceEntities({
      organizationRole: session.organizationRole,
      workspaceMemberId: session.workspaceMemberId,
    })
  ) {
    return null;
  }

  const pendingRequests = await tx
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
