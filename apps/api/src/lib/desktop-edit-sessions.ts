import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { db } from "@/api/db/root";
import { desktopEditSessions, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

type AuthorizedDesktopEditSession = {
  fileName: string;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  userId: string;
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
    };

/** Session tokens expire after 24 hours. Each checkpoint extends by this amount. */
export const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export const computeTokenExpiresAt = () =>
  new Date(Date.now() + SESSION_TOKEN_TTL_MS);

const SESSION_TOKEN_PART_LENGTH = 32;

export const DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE =
  "desktop_edit_session_taken_over";
export const DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE =
  "Desktop editing moved to another device. This local copy is preserved.";

export const createDesktopEditSessionToken = () =>
  Bun.randomUUIDv7().replaceAll("-", "").slice(0, SESSION_TOKEN_PART_LENGTH) +
  Bun.randomUUIDv7().replaceAll("-", "").slice(0, SESSION_TOKEN_PART_LENGTH);

export const hashDesktopEditSessionToken = (sessionToken: string) =>
  new Bun.CryptoHasher("sha256").update(sessionToken).digest("hex");

export const authorizeDesktopEditSession = async ({
  sessionId,
  sessionToken,
}: {
  sessionId: SafeId<"desktopEditSession">;
  sessionToken: string;
}): Promise<DesktopEditSessionAuthorizationResult> => {
  const tokenHash = hashDesktopEditSessionToken(sessionToken);

  const rows = await db
    .select({
      createdBy: desktopEditSessions.createdBy,
      fileName: desktopEditSessions.fileName,
      organizationId: workspaces.organizationId,
      sessionStatus: desktopEditSessions.status,
      sessionTokenHash: desktopEditSessions.sessionTokenHash,
      tokenExpiresAt: desktopEditSessions.tokenExpiresAt,
      workspaceId: desktopEditSessions.workspaceId,
    })
    .from(desktopEditSessions)
    .innerJoin(workspaces, eq(desktopEditSessions.workspaceId, workspaces.id))
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

  return {
    status: "authorized",
    value: {
      fileName: session.fileName,
      organizationId: session.organizationId,
      scopedDb: createRootScopedDb({
        organizationId: session.organizationId,
        userId: brandPersistedUserId(session.createdBy),
        workspaceIds: [session.workspaceId],
      }),
      userId: session.createdBy,
      workspaceId: session.workspaceId,
    },
  };
};
