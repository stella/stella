import { queryOptions } from "@tanstack/react-query";

import type { ChatToolGrantScope } from "@stll/api-contract/chat-tool-grants";

import type {
  ApprovalToolName,
  ToolApprovalGrant,
} from "@/components/chat/chat-ui-tools";
import {
  getExternalMcpConnectorApprovalGrant,
  isToolApprovalGrant,
} from "@/components/chat/chat-ui-tools";
import { chatKeys } from "@/features/chat/chat-query-contract";
import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

type ChatToolGrantsKey = {
  activeOrganizationId: string;
  threadId: string;
  userId: string;
};

/**
 * The stored approvals the API applies in this conversation. The API skips
 * the prompt for calls these cover; the client reads them only to answer
 * cards that were already asking when a grant was added.
 */
export const chatToolGrantsOptions = ({
  activeOrganizationId,
  threadId,
  userId,
}: ChatToolGrantsKey) =>
  queryOptions({
    queryKey: chatKeys.toolGrants(activeOrganizationId, userId, threadId),
    queryFn: async ({ signal }) => {
      const response = await api.chat["tool-grants"].get({
        query: { threadId: toSafeId<"chatThread">(threadId) },
        fetch: { signal },
      });
      return unwrapApiResponse(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export type ChatToolGrantsResponse = Awaited<
  ReturnType<NonNullable<ReturnType<typeof chatToolGrantsOptions>["queryFn"]>>
>;

/** Whether the API holds a grant covering `toolName` in this conversation now. */
export const readChatToolGrantCoverage = async ({
  threadId,
  toolName,
}: {
  threadId: string;
  toolName: ApprovalToolName;
}) =>
  unwrapApiResponse(
    await api.chat["tool-grants"].coverage.get({
      query: { threadId: toSafeId<"chatThread">(threadId), toolName },
    }),
  );

export const storeChatToolGrant = async ({
  scope,
  threadId,
  toolName,
}: {
  scope: ChatToolGrantScope;
  threadId: string;
  toolName: ApprovalToolName;
}) =>
  unwrapApiResponse(
    await api.chat["tool-grants"].post({
      scope,
      threadId: toSafeId<"chatThread">(threadId),
      toolName,
    }),
  );

/**
 * Splits stored grants by scope into the approval-card grant sets. Until the
 * grants load (`undefined`), no call is pre-approved.
 */
export const projectChatToolGrants = (
  grants: ChatToolGrantsResponse["grants"] | undefined,
): Record<ChatToolGrantScope, ReadonlySet<ToolApprovalGrant>> => {
  const projected = {
    always: new Set<ToolApprovalGrant>(),
    conversation: new Set<ToolApprovalGrant>(),
  };
  if (grants === undefined) {
    return projected;
  }
  for (const grant of grants) {
    const approvalGrant = toApprovalGrant(grant);
    if (approvalGrant !== null) {
      projected[grant.scope].add(approvalGrant);
    }
  }
  return projected;
};

const toApprovalGrant = (
  grant: ChatToolGrantsResponse["grants"][number],
): ToolApprovalGrant | null => {
  if (grant.toolName !== null) {
    return isToolApprovalGrant(grant.toolName) ? grant.toolName : null;
  }
  return grant.mcpConnectorToolNamespace === null
    ? null
    : getExternalMcpConnectorApprovalGrant(grant.mcpConnectorToolNamespace);
};
