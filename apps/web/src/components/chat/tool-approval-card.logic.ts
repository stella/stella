import {
  isNonPersistentGrantChatToolName,
  isToolApprovedByGrant,
} from "@/components/chat/chat-ui-tools";
import type {
  ApprovalToolName,
  ToolApprovalGrant,
} from "@/components/chat/chat-ui-tools";

type HasAutomaticApprovalOptions = {
  alwaysApprovedTools: ReadonlySet<ToolApprovalGrant>;
  canAlwaysAllow: boolean;
  conversationApprovedTools: ReadonlySet<ToolApprovalGrant>;
  isDocxEditBatch: boolean;
  isPublicOfficialApproval: boolean;
  name: ApprovalToolName;
};

export const hasAutomaticApproval = ({
  alwaysApprovedTools,
  canAlwaysAllow,
  conversationApprovedTools,
  isDocxEditBatch,
  isPublicOfficialApproval,
  name,
}: HasAutomaticApprovalOptions) =>
  !isNonPersistentGrantChatToolName(name) &&
  (isDocxEditBatch ||
    isPublicOfficialApproval ||
    isToolApprovedByGrant(conversationApprovedTools, name) ||
    (canAlwaysAllow && isToolApprovedByGrant(alwaysApprovedTools, name)));
