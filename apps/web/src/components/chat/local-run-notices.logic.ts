import {
  type ChatLocalRunNotice,
  chatLocalRunNoticesOf,
  endedChatLocalRunNotices,
  isChatLocalRunNoticeShown,
} from "@stll/api-contract/chat-local-run-notice";

import type { ChatMessageMetadata } from "@/components/chat/chat-ui-tools-types";

/**
 * The notices an answer shows: a retry that ended with its turn says
 * nothing, and once the turn no longer runs, one still under way (a stop cut
 * its stream off) has ended too. Whether an answer draws anything goes by
 * the same list.
 */
export const shownLocalRunNotices = (
  metadata: ChatMessageMetadata | undefined,
  isTurnActive: boolean,
): readonly ChatLocalRunNotice[] => {
  const reported = chatLocalRunNoticesOf(metadata);
  const settled = isTurnActive
    ? reported
    : (endedChatLocalRunNotices(reported) ?? reported);
  return settled.filter(isChatLocalRunNoticeShown);
};
