import { Result, panic } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tUserId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";

const addWorkspaceMemberBodySchema = t.Object({
  userId: tUserId,
});

const config = {
  permissions: { workspace: ["update"] },
  body: addWorkspaceMemberBodySchema,
} satisfies HandlerConfig;

const addWorkspaceMember = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
    // Verify user is a member of the organization.
    // `member` is an org-level auth table (no RLS policy);
    // safeDb works for querying it.
    const orgMember = yield* Result.await(
      safeDb((tx) =>
        tx.query.member.findFirst({
          where: {
            userId: { eq: body.userId },
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!orgMember) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "User is not a member of this organization",
        }),
      );
    }

    const txResult = await safeDb(async (tx) => {
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
    });

    if (Result.isError(txResult)) {
      if (
        DatabaseError.is(txResult.error) &&
        txResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "User is already a member of this workspace",
          }),
        );
      }
      return Result.err(txResult.error);
    }

    if (!txResult.value.ok) {
      if (txResult.value.reason === "not_found") {
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

    const created = txResult.value.rows.at(0);
    if (!created) {
      panic("Failed to add workspace member");
    }

    return Result.ok(created);
  },
);

export default addWorkspaceMember;
