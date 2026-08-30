import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { WorkspaceStorageTeardownBoundError } from "@/api/lib/organization-storage-teardown";
import { executeAuthorizedWorkspaceDeletion } from "@/api/lib/workspace-deletion";

const config = {
  description:
    "Permanently delete a matter and all its documents, tasks, fields, and " +
    "chat history. This is irreversible.",
  permissions: { workspace: ["delete"] },
  mcp: { type: "tool", name: "delete_matter" },
} satisfies HandlerConfig;

export type DeleteWorkspaceHandlerProps = {
  actorUserId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  workspaceId: SafeId<"workspace">;
};

// Shared matter-delete logic reused by HTTP and MCP. The inner command repeats
// authorization in the transaction that owns the privileged teardown.
// eslint-disable-next-line require-yield -- generator keeps the shared handler Result contract
export const deleteWorkspaceHandler = async function* (
  props: DeleteWorkspaceHandlerProps,
) {
  const outcome = await executeAuthorizedWorkspaceDeletion(props);
  if (Result.isError(outcome)) {
    if (outcome.error instanceof WorkspaceStorageTeardownBoundError) {
      return Result.err(
        new HandlerError({ status: 400, message: outcome.error.message }),
      );
    }
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to delete workspace records",
        cause: outcome.error,
      }),
    );
  }

  if (outcome.value.status === "deleted") {
    return Result.ok({});
  }
  if (outcome.value.status === "not-authorized") {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Workspace access was revoked",
      }),
    );
  }
  if (outcome.value.status === "not-found") {
    return Result.err(
      new HandlerError({ status: 404, message: "Workspace not found" }),
    );
  }
  return Result.err(
    new HandlerError({
      status: 409,
      message:
        "Wait for document processing or another deletion attempt to finish",
    }),
  );
};

const deleteWorkspace = createSafeHandler(
  config,
  async function* ({ workspaceId, session, user, recordAuditEvent }) {
    return yield* deleteWorkspaceHandler({
      actorUserId: user.id,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      workspaceId,
    });
  },
);

export default deleteWorkspace;
