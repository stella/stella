import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { status, t } from "elysia";

import { workspaceMembers } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

const addWorkspaceMemberBodySchema = t.Object({
  userId: t.String({ maxLength: 128 }),
});

const config = {
  permissions: { workspace: ["update"] },
  body: addWorkspaceMemberBodySchema,
} satisfies HandlerConfig;

const addWorkspaceMember = createHandler(
  config,
  async ({ scopedDb, session, workspaceId, body }) => {
    // Verify user is a member of the organization.
    // `member` is an org-level auth table (no RLS policy);
    // scopedDb works for querying it.
    const orgMember = await scopedDb((tx) =>
      tx.query.member.findFirst({
        where: {
          userId: { eq: body.userId },
          organizationId: { eq: session.activeOrganizationId },
        },
        columns: { id: true },
      }),
    );

    if (!orgMember) {
      return status(400, {
        message: "User is not a member of this organization",
      });
    }

    const result = await Result.tryPromise({
      try: async () =>
        await scopedDb(async (tx) => {
          // Lock rows then count to serialize concurrent adds.
          // PG rejects FOR UPDATE with aggregate functions, so
          // we select rows first and count in application code.
          const lockedRows = await tx
            .select({ id: workspaceMembers.id })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.workspaceId, workspaceId))
            .for("update");

          if (lockedRows.length >= LIMITS.workspaceMembersCount) {
            return null;
          }

          return tx
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
        }),
      catch: (error) => error,
    });

    if (result.isErr()) {
      if (isPgError(result.error, PG_ERROR.UNIQUE_VIOLATION)) {
        return status(409, {
          message: "User is already a member of this workspace",
        });
      }
      throw result.error;
    }

    if (result.value === null) {
      return status(400, {
        message: "Workspace members limit reached",
      });
    }

    const [created] = result.value;
    return created;
  },
);

export default addWorkspaceMember;
