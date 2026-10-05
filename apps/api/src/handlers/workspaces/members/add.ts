import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { member } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { workspaceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tUserId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";

const addWorkspaceMemberBodySchema = t.Object({
  userId: tUserId,
});

const config = {
  description:
    "Add one member of the organization to a matter, granting them access to " +
    "it. A user who is already a member is a 409, and the call is refused " +
    "once the matter holds its maximum number of members. Revoke access with " +
    "matters.members.remove.",
  permissions: { workspace: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  realtime: workspaceRealtimeUpdates,
  mcp: { type: "tool", name: "manage_organization" },
  body: addWorkspaceMemberBodySchema,
} satisfies WorkspaceHandlerConfig;

export type AddWorkspaceMemberProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof addWorkspaceMemberBodySchema>;
};

// Shared add-member logic reused by the HTTP handler and the
// `manage_organization` MCP tool, so both emit the identical audit event and
// enforce the same org-membership, workspace-lock, and member-count rules.
export const addWorkspaceMemberHandler = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  recordAuditEvent,
  body,
}: AddWorkspaceMemberProps) {
  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      // Lock the workspace row first so concurrent workspace
      // deletion or promotion cannot race this membership insert.
      const workspaceRows = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update");
      const workspace = workspaceRows.at(0);

      if (!workspace) {
        return { ok: false as const, reason: "not_found" as const };
      }

      // Workspace -> organization membership -> matter memberships, matching promotion.
      const orgMembers = await tx
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.userId, body.userId),
          ),
        )
        .for("key share");
      if (orgMembers.length === 0) {
        return { ok: false as const, reason: "not_member" as const };
      }
      // Lock workspace_members rows then count to serialize concurrent adds.
      // PG rejects FOR UPDATE with aggregate functions, so
      // we select rows first and count in application code.
      const lockedRows = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId))
        .for("update");

      if (lockedRows.length >= LIMITS.workspaceMembersCount) {
        return { ok: false as const, reason: "limit" as const };
      }

      const rows = await tx
        .insert(workspaceMembers)
        .values({
          workspaceId,
          userId: body.userId,
        })
        .returning({
          id: workspaceMembers.id,
          userId: workspaceMembers.userId,
          createdAt: workspaceMembers.createdAt,
        });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
        resourceId: workspaceId,
        changes: {
          membersAdded: {
            old: null,
            new: [body.userId],
          },
        },
      });

      return { ok: true as const, rows };
    }).then((result) =>
      result.mapError((error) =>
        DatabaseError.is(error) && error.code === PG_ERROR.UNIQUE_VIOLATION
          ? new HandlerError({
              status: 409,
              message: "User is already a member of this workspace",
            })
          : error,
      ),
    ),
  );

  if (!txResult.ok) {
    if (txResult.reason === "not_member") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "User is not a member of this organization",
        }),
      );
    }
    if (txResult.reason === "not_found") {
      return Result.err(
        new HandlerError({ status: 404, message: "Workspace not found" }),
      );
    }
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Workspace members limit reached",
      }),
    );
  }

  const created = txResult.rows.at(0);
  if (!created) {
    panic("Failed to add workspace member");
  }

  return Result.ok(created);
};

const addWorkspaceMember = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
    return yield* addWorkspaceMemberHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default addWorkspaceMember;
