import { Result } from "better-result";

import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ResolveChatScopeProps = {
  getWorkspaceAccess: (
    workspaceId: SafeId<"workspace">,
  ) => Promise<AccessibleWorkspace | null>;
  workspaceId?: SafeId<"workspace"> | undefined;
};

export const resolveChatScope = async function* ({
  getWorkspaceAccess,
  workspaceId,
}: ResolveChatScopeProps) {
  if (!workspaceId) {
    return { scope: "global" } as const;
  }

  const workspace = yield* Result.await(
    Result.tryPromise(async () => await getWorkspaceAccess(workspaceId)),
  );

  if (!workspace || workspace.status === "deleting") {
    return yield* Result.err(
      new HandlerError({
        status: 404,
        message: "Workspace not found",
      }),
    );
  }

  return {
    scope: "workspace",
    workspaceId: workspace.id,
  } as const;
};

export type ChatScope =
  | { scope: "global" }
  | { scope: "workspace"; workspaceId: SafeId<"workspace"> };

type AssertChatThreadScopeMatchesProps = {
  persistedWorkspaceId: SafeId<"workspace"> | null;
  scope: ChatScope;
};

/**
 * Reject a request whose chat scope contradicts the persisted thread: a
 * workspace-scoped thread asked for as global (or vice versa) is a client bug.
 * Fail loud with a 400 instead of silently 404'ing or creating a duplicate.
 */
export const assertChatThreadScopeMatches = ({
  persistedWorkspaceId,
  scope,
}: AssertChatThreadScopeMatchesProps): Result<void, HandlerError<400>> => {
  const requestedWorkspaceId =
    scope.scope === "workspace" ? scope.workspaceId : null;
  if (persistedWorkspaceId !== requestedWorkspaceId) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Chat thread scope does not match request",
      }),
    );
  }
  return Result.ok();
};
