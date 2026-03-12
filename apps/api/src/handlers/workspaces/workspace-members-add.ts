import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { workspaceMembers } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

export const addWorkspaceMemberBodySchema = t.Object({
  userId: t.String({ maxLength: 128 }),
});

type AddWorkspaceMemberBody = Static<typeof addWorkspaceMemberBodySchema>;

type AddWorkspaceMemberHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  body: AddWorkspaceMemberBody;
};

export const addWorkspaceMemberHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
  body,
}: AddWorkspaceMemberHandlerProps) => {
  // Verify user is a member of the organization.
  // `member` is an org-level auth table (no RLS policy);
  // scopedDb works for querying it.
  const orgMember = await scopedDb((tx) =>
    tx.query.member.findFirst({
      where: {
        userId: { eq: body.userId },
        organizationId: { eq: organizationId },
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
};
