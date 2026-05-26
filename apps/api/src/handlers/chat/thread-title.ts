export const CHAT_THREAD_PLACEHOLDER_TITLE = "New chat";

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
