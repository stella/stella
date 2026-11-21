import { useQuery } from "@tanstack/react-query";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { ChatTitleRename } from "@/features/chat/components/chat-title-rename";
import { chatThreadTitleOptions } from "@/features/chat/queries";
import type { ChatThreadFetched } from "@/features/chat/queries";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { queryView } from "@/lib/query-view.logic";

type FileChatTitleSlotProps = {
  activeOrganizationId: string;
  hasMessages: boolean;
  /** The server's read of the thread; the title is read once it has a row. */
  persistedThread: ChatThreadFetched;
  threadRef: ChatThreadRef;
  usedAnonymization: boolean;
};

// Title area of the floating thread card: resolves the persisted title with
// the bounded by-id read (file threads are not guaranteed to be in the
// grouped-threads window) and mounts the shared rename affordance on it.
export const FileChatTitleSlot = ({
  activeOrganizationId,
  hasMessages,
  persistedThread,
  threadRef,
  usedAnonymization,
}: FileChatTitleSlotProps) => {
  const titleQueryOptions = chatThreadTitleOptions({
    activeOrganizationId,
    key: {
      threadId: threadRef.threadId,
      workspaceId:
        threadRef.scope === "workspace" ? threadRef.workspaceId : undefined,
    },
    persistedThread,
  });
  const titleQuery = useQuery(titleQueryOptions);
  const titleView = queryView(titleQuery);
  const byIdTitle = titleView.type === "items" ? titleView.items : undefined;
  // Feedback belongs to a read that ran: a first message still being sent
  // has no row to read yet, and its card shows the placeholder title.
  const titleRead = titleQueryOptions.enabled === true;
  if (titleRead && titleView.type !== "items") {
    return <QueryViewFeedback view={titleView} />;
  }
  const title =
    byIdTitle !== undefined && !isPlaceholderThreadTitle(byIdTitle)
      ? byIdTitle
      : "";

  return (
    <span className="flex min-w-0 items-center text-xs font-medium">
      {titleRead && <QueryViewFeedback view={titleView} />}
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
