import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import { SourceChips } from "@/features/chat/source-chips";

import { AnswerRevisionHistory } from "./answer-revision-history";

export const AssistantAnswerMetadata = ({
  message,
  activeOrganizationId,
  workspaceId,
  threadId,
  disabled,
  onAnswerEdited,
}: {
  message: ChatUIMessage;
  activeOrganizationId: string;
  workspaceId?: string | undefined;
  threadId?: string | undefined;
  disabled: boolean;
  onAnswerEdited?: ((messageId: string) => Promise<void>) | undefined;
}) => (
  <>
    {message.revision !== undefined &&
      message.revision > 0 &&
      threadId !== undefined && (
        <AnswerRevisionHistory
          threadId={threadId}
          messageId={message.id}
          revision={message.revision}
          disabled={disabled}
          onAnswerEdited={onAnswerEdited}
        />
      )}
    <SourceChips
      activeOrganizationId={activeOrganizationId}
      messageId={message.id}
      parts={message.parts}
      sourceDocuments={message.metadata?.sourceDocuments}
      workspaceId={workspaceId}
    />
  </>
);
