import { CHAT_TITLE_SOURCE } from "@/api/db/schema";
import type { ChatTitleSource } from "@/api/db/schema";

export const CHAT_THREAD_PLACEHOLDER_TITLE = "New chat";

/**
 * Whether background AI title generation may replace a thread's current title.
 * Only a still-default placeholder ("default") is replaceable: a user rename
 * ("user") and a title the generator already wrote ("ai") are left untouched,
 * so a rename that races the fire-and-forget generator always wins.
 */
export const aiTitlingMayReplace = (source: ChatTitleSource): boolean =>
  source === CHAT_TITLE_SOURCE.DEFAULT;

export const isPlaceholderThreadTitle = (title: string) =>
  title === CHAT_THREAD_PLACEHOLDER_TITLE;

type ShouldRefreshEmptyThreadTitleProps = {
  messageCount: number;
  title: string;
};

export const shouldRefreshEmptyThreadTitle = ({
  messageCount,
  title,
}: ShouldRefreshEmptyThreadTitleProps) =>
  messageCount === 0 && isPlaceholderThreadTitle(title);
