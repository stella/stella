import { Result } from "better-result";
import { status, t } from "elysia";

import { recoverMatterSteward } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUserId, workspaceParams } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasManagementPermission } from "@/api/lib/permission-authorization";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const config = {
  contract: "patch",
  description:
    "Recover an assigned-only matter without a usable lead by naming an internal organization member. Owners and admins only. Assigns that member and makes them lead atomically, preserves visibility, and returns no matter metadata. A healthy matter uses the normal lead update instead.",
  permissions: { workspace: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: false,
  },
  params: workspaceParams({}),
  body: t.Object({ stewardUserId: tUserId }),
} as const satisfies HandlerConfig;

type RecoverMatterStewardDependencies = {
  recoverInTransaction: (
    options: Parameters<typeof recoverMatterSteward>[0],
  ) => Promise<void>;
};

export const createRecoverMatterSteward = ({
  recoverInTransaction,
}: RecoverMatterStewardDependencies) =>
  createSafeRootHandler(
    config,
    async function* ({
      session,
      user,
      memberRole,
      params,
      body,
      createAuditRecorder,
    }) {
      if (!hasManagementPermission(memberRole, { workspace: ["update"] })) {
        return Result.err(
          new HandlerError({
            status: 403,
            code: "forbidden",
            message:
              "Only organization owners and admins can recover a matter steward",
          }),
        );
      }
      yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await recoverInTransaction({
              organizationId: session.activeOrganizationId,
              workspaceId: params.workspaceId,
              actorUserId: user.id,
              stewardUserId: brandPersistedUserId(body.stewardUserId),
              recordAuditEvent: createAuditRecorder({
                workspaceId: params.workspaceId,
              }),
            }),
          catch: (cause) =>
            HandlerError.is(cause)
              ? cause
              : new DatabaseError({
                  message: "Failed to recover matter steward",
                  cause,
                }),
        }),
      );
      return Result.ok(status(204));
    },
  );

// Recovery deliberately has organization management authority without granting
// read access. The owner validates organization, actor and steward under locks.
export default createRecoverMatterSteward({
  recoverInTransaction: recoverMatterSteward,
});
