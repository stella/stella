import { useQuery } from "@tanstack/react-query";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { ChatTitleRename } from "@/features/chat/components/chat-title-rename";
import { chatThreadTitleOptions } from "@/features/chat/queries";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { useQueryView } from "@/lib/use-query-view";

type FileChatTitleSlotProps = {
  activeOrganizationId: string;
  hasMessages: boolean;
  threadRef: ChatThreadRef;
  usedAnonymization: boolean;
};

// Title area of the floating thread card: resolves the persisted title with
// the bounded by-id read (file threads are not guaranteed to be in the
// grouped-threads window) and mounts the shared rename affordance on it.
export const FileChatTitleSlot = ({
  activeOrganizationId,
  hasMessages,
  threadRef,
  usedAnonymization,
}: FileChatTitleSlotProps) => {
  const titleQuery = useQuery(
    chatThreadTitleOptions({
      activeOrganizationId,
      // A message-less thread has no server row yet; issuing GET /title for
      // it would produce an expected but noisy 404.
      enabled: hasMessages,
      key: {
        threadId: threadRef.threadId,
        workspaceId:
          threadRef.scope === "workspace" ? threadRef.workspaceId : undefined,
      },
    }),
  );
  const titleView = useQueryView(titleQuery);
  const byIdTitle = titleView.type === "items" ? titleView.items : undefined;
  if (hasMessages && titleView.type !== "items") {
    return <QueryViewFeedback view={titleView} />;
  }
  const title =
    byIdTitle !== undefined && !isPlaceholderThreadTitle(byIdTitle)
      ? byIdTitle
      : "";

  return (
    <span className="flex min-w-0 items-center text-xs font-medium">
      {hasMessages && <QueryViewFeedback view={titleView} />}
      <ChatTitleRename
        hasMessages={hasMessages}
        ownsRenameCommand
        threadRef={threadRef}
        title={title}
        usedAnonymization={usedAnonymization}
      />
    </span>
  );
};
