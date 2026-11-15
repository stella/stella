import { Result } from "better-result";

import { CHAT_THREAD_SCOPE_MISMATCH_CODE } from "@stll/api-contract/chat-thread-scope";

import {
  type AccessibleWorkspace,
  admitsWorkspaceStatus,
  type WorkspaceStatusAccess,
} from "@/api/lib/auth/accessible-workspace";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ResolveChatScopeProps = {
  /**
   * Required on purpose: every chat handler states whether it only reads the
   * matter ("active-or-archived") or writes to it ("active"), the same choice
   * a `:workspaceId` route makes through `authorizeWorkspace`. An archived
   * matter is read-only, so a write against it answers 404 like any other
   * matter route.
   */
  admitted: WorkspaceStatusAccess;
  getWorkspaceAccess: (
    workspaceId: SafeId<"workspace">,
  ) => Promise<AccessibleWorkspace | null>;
  workspaceId?: SafeId<"workspace"> | undefined;
};

export const resolveChatScope = async function* ({
  admitted,
  getWorkspaceAccess,
  workspaceId,
}: ResolveChatScopeProps) {
  if (!workspaceId) {
    return { scope: "global" } as const;
  }

  const workspace = yield* Result.await(
    Result.tryPromise(async () => await getWorkspaceAccess(workspaceId)),
  );

  if (!workspace || !admitsWorkspaceStatus(workspace.status, admitted)) {
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

export type ChatWorkspaceAccess = (
  workspaceId: SafeId<"workspace">,
) => Promise<AccessibleWorkspace | null>;

type HasChatWorkspaceAccessOptions = {
  /** Same contract as `resolveChatScope`'s `admitted`. */
  admitted: WorkspaceStatusAccess;
  workspaceId: SafeId<"workspace"> | null;
  getWorkspaceAccess: ChatWorkspaceAccess;
};

export const hasChatWorkspaceAccess = async ({
  admitted,
  workspaceId,
  getWorkspaceAccess,
}: HasChatWorkspaceAccessOptions) => {
  if (workspaceId === null) {
    return true;
  }
  const workspace = await getWorkspaceAccess(workspaceId);
  return admitsWorkspaceStatus(workspace?.status, admitted);
};

type ChatThreadScopeMismatchErrorOptions = {
  workspaceId: SafeId<"workspace"> | null;
  getWorkspaceAccess: ChatWorkspaceAccess;
};

export const chatThreadScopeMismatchError = async ({
  workspaceId,
  getWorkspaceAccess,
}: ChatThreadScopeMismatchErrorOptions): Promise<HandlerError<400 | 404>> => {
  const canReadWorkspace = await hasChatWorkspaceAccess({
    admitted: "active-or-archived",
    workspaceId,
    getWorkspaceAccess,
  });
  if (workspaceId === null || !canReadWorkspace) {
    return new HandlerError({
      status: 404,
      message: "Chat thread not found",
    });
  }

  return new HandlerError({
    status: 400,
    code: CHAT_THREAD_SCOPE_MISMATCH_CODE,
    message: "Chat thread scope does not match request",
    workspaceId,
  });
};
