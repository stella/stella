import { panic, Result } from "better-result";
import { and, eq, gt, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import type { DesktopHandoffFailureReason } from "@stll/api-contract/desktop-handoff";

import { member } from "@/api/db/auth-schema";
import { rootDb, rlsDb } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  desktopEditHandoffs,
  desktopEditSessions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import {
  createBackgroundAuditRecorder,
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { hashDesktopEditHandoffToken } from "@/api/lib/desktop-edit-sessions";
import { canWriteWorkspaceEntities } from "@/api/lib/entities/workspace-entity-write-access";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { recordPdfSigningHandoffFailure } from "@/api/lib/files/pdf-signing/sessions";
import { tokenScopedDatabase } from "@/api/lib/root-scoped-db";

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

type DesktopHandoffIdentity = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
};

type ConsumeDesktopEditHandoffOptions = {
  handoffToken: string;
  identity: DesktopHandoffIdentity;
  db?: Pick<typeof rootDb, "update" | "select">;
  now?: Date;
};

export class DesktopHandoffAccountMismatchError extends HandlerError<409> {
  constructor() {
    super({
      status: 409,
      code: "desktop_account_mismatch",
      message: "Desktop is linked to a different account or organization.",
    });
    this.name = "DesktopHandoffAccountMismatchError";
  }
}

export const consumeDesktopEditHandoff = async ({
  handoffToken,
  identity,
  db = rootDb,
  now = new Date(),
}: ConsumeDesktopEditHandoffOptions): Promise<
  Result<ConsumedDesktopEditHandoff | null, DesktopHandoffAccountMismatchError>
> => {
  const tokenHash = hashDesktopEditHandoffToken(handoffToken);

  const rows = await db
    .update(desktopEditHandoffs)
    .set({ consumedAt: now })
    .where(
      and(
        eq(desktopEditHandoffs.tokenHash, tokenHash),
        eq(desktopEditHandoffs.createdBy, identity.userId),
        sql`exists (select 1 from ${workspaces}
          where ${workspaces.id} = ${desktopEditHandoffs.workspaceId}
            and ${workspaces.organizationId} = ${identity.organizationId})`,
        isNull(desktopEditHandoffs.consumedAt),
        isNull(desktopEditHandoffs.failedAt),
        gt(
          desktopEditHandoffs.expiresAt,
          sql`${now.toISOString()}::timestamptz`,
        ),
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

  const consumed = rows.at(0);
  if (consumed) {
    return Result.ok(consumed);
  }

  const mismatch = await db
    .select({ id: desktopEditHandoffs.id })
    .from(desktopEditHandoffs)
    .innerJoin(workspaces, eq(workspaces.id, desktopEditHandoffs.workspaceId))
    .where(
      and(
        eq(desktopEditHandoffs.tokenHash, tokenHash),
        isNull(desktopEditHandoffs.consumedAt),
        isNull(desktopEditHandoffs.failedAt),
        gt(
          desktopEditHandoffs.expiresAt,
          sql`${now.toISOString()}::timestamptz`,
        ),
        or(
          ne(desktopEditHandoffs.createdBy, identity.userId),
          ne(workspaces.organizationId, identity.organizationId),
        ),
      ),
    )
    .limit(1);
  if (mismatch.at(0)) {
    return Result.err(new DesktopHandoffAccountMismatchError());
  }
  return Result.ok(null);
};

export const markDesktopEditHandoffOpened = async ({
  handoffId,
  handoffToken,
  sessionId,
  identity,
}: {
  handoffId: SafeId<"desktopEditHandoff">;
  handoffToken: string;
  sessionId: SafeId<"desktopEditSession">;
  identity: DesktopHandoffIdentity;
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
        eq(desktopEditHandoffs.createdBy, identity.userId),
        sql`exists (select 1 from ${workspaces}
          where ${workspaces.id} = ${desktopEditHandoffs.workspaceId}
            and ${workspaces.organizationId} = ${identity.organizationId})`,
        isNotNull(desktopEditHandoffs.consumedAt),
        sql`exists (
          select 1
          from ${desktopEditSessions}
          where ${desktopEditSessions.id} = ${sessionId}
            and ${desktopEditSessions.workspaceId} = ${desktopEditHandoffs.workspaceId}
            and ${desktopEditSessions.createdBy} = ${desktopEditHandoffs.createdBy}
            and ${desktopEditSessions.entityId} = ${desktopEditHandoffs.entityId}
            and ${desktopEditSessions.propertyId} = ${desktopEditHandoffs.propertyId}
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
    canWriteWorkspaceEntities: canWriteWorkspaceEntities({
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

type RecordDesktopHandoffFailureOptions = {
  kind: "desktop_edit" | "pdf_signing";
  handoffToken: string;
  reason: DesktopHandoffFailureReason;
  db?: Pick<typeof rootDb, "transaction">;
  now?: Date;
};

/** A handoff token authorizes only a terminal acknowledgement, never document access. */
export const recordDesktopHandoffFailure = async ({
  kind,
  handoffToken,
  reason,
  db = rootDb,
  now = new Date(),
}: RecordDesktopHandoffFailureOptions): Promise<boolean> => {
  if (kind === "pdf_signing") {
    return recordPdfSigningHandoffFailure({
      handoffToken,
      reason,
      db: tokenScopedDatabase,
      now,
    });
  }
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(desktopEditHandoffs)
      .set({ failedAt: now, failureReason: reason })
      .where(
        and(
          eq(
            desktopEditHandoffs.tokenHash,
            hashDesktopEditHandoffToken(handoffToken),
          ),
          isNull(desktopEditHandoffs.consumedAt),
          isNull(desktopEditHandoffs.openedAt),
          isNull(desktopEditHandoffs.failedAt),
          gt(
            desktopEditHandoffs.expiresAt,
            sql`${now.toISOString()}::timestamptz`,
          ),
        ),
      )
      .returning({
        id: desktopEditHandoffs.id,
        workspaceId: desktopEditHandoffs.workspaceId,
        createdBy: desktopEditHandoffs.createdBy,
      });
    const handoff = rows.at(0);
    if (!handoff) {
      return false;
    }
    const workspacesForAudit = await tx
      .select({ organizationId: workspaces.organizationId })
      .from(workspaces)
      .where(eq(workspaces.id, handoff.workspaceId))
      .limit(1);
    const workspace = workspacesForAudit.at(0);
    if (!workspace) {
      return panic("Desktop handoff workspace must exist");
    }
    const recordAuditEvent = createBackgroundAuditRecorder({
      organizationId: workspace.organizationId,
      workspaceId: handoff.workspaceId,
      userId: handoff.createdBy,
      execution: {
        performer: {
          type: "service",
          id: "desktop-handoff",
          name: "Desktop handoff",
        },
        trigger: { type: "system", source: "desktop-handoff" },
      },
    });
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
      resourceId: handoff.id,
      changes: { failureReason: { old: null, new: reason } },
      metadata: { kind: "handoff" },
    });
    return true;
  });
};
