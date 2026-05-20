import { createContext, use } from "react";

import type {
  ApprovalToolName,
  ToolApprovalGrant,
} from "@/components/chat/chat-ui-tools";

/**
 * Tool-approval handlers and grant sets shared by every leaf that
 * renders a `tool-approval` part (currently `ToolApprovalCard`).
 *
 * Each chat surface (page, tab panel, file overlay) wraps its
 * subtree with a provider so the approval card can resolve the
 * full state machine without `ChatThreadMessages` and
 * `AssistantMessageParts` having to thread it through.
 *
 * Handler signatures match `useChatSession`'s exports verbatim;
 * the provider is a thin pass-through.
 */
type ChatApprovalContextValue = {
  activeOrganizationId: string;
  handleAllowInConversation: (
    id: string,
    toolName: ApprovalToolName,
  ) => void | PromiseLike<void>;
  handleAlwaysAllow: (
    id: string,
    toolName: ApprovalToolName,
  ) => void | PromiseLike<void>;
  handleApprove: (
    id: string,
    toolName: ApprovalToolName,
  ) => void | PromiseLike<void>;
  handleDeny: (id: string) => void | PromiseLike<void>;
  alwaysApprovedTools: ReadonlySet<ToolApprovalGrant>;
  conversationApprovedTools: ReadonlySet<ToolApprovalGrant>;
  /**
   * Optional set of tool names that should be auto-denied (e.g.
   * tools blocked while a specific file overlay is active). Leaves
   * read this directly so the policy stays close to the gate.
   */
  blockedApprovalTools?: ReadonlySet<ApprovalToolName> | undefined;
};

export const ChatApprovalContext =
  createContext<ChatApprovalContextValue | null>(null);

export const useChatApproval = (): ChatApprovalContextValue => {
  const value = use(ChatApprovalContext);
  if (value === null) {
    throw new Error(
      "useChatApproval must be used inside a <ChatApprovalContext> provider",
    );
  }
  return value;
};
