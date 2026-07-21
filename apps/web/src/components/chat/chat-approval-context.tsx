import { createContext, use } from "react";

import { panic } from "better-result";

import type {
  ApprovalToolName,
  ToolApprovalGrant,
} from "@/components/chat/chat-ui-tools";
import type { ChatSendMessageOptions } from "@/routes/_protected.chat/-queries";

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
    options?: ChatSendMessageOptions,
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
  /**
   * Regenerates the current turn after the user has just set a preferred
   * name from `edit_workspace_document`'s "author name required" modal
   * (see `EDIT_WORKSPACE_DOCUMENT_AUTHOR_NAME_REQUIRED_CODE` on the
   * backend). Maps to `chat.reload()` (via `resendLatestMessage`) so the
   * model can re-issue the same tool call now that
   * `resolveDocxEditAuthorName` resolves. Optional: surfaces that never
   * register the `auto` DOCX-edit tool (every surface but the file
   * overlay) never need to supply it.
   */
  handleRetryAfterAuthorNameSet?: (() => void | PromiseLike<void>) | undefined;
};

export const ChatApprovalContext =
  createContext<ChatApprovalContextValue | null>(null);

export const useChatApproval = (): ChatApprovalContextValue => {
  const value = use(ChatApprovalContext);
  if (value === null) {
    panic(
      "useChatApproval must be used inside a <ChatApprovalContext> provider",
    );
  }
  return value;
};
